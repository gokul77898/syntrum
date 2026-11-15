import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from "node:net";
import { dirname } from "node:path";

import { AdapterError } from "../adapters/errors.js";
import type {
  AgentIdentity as AdapterAgentIdentity,
  ApplicationAdapter,
  ReadEventsOptions
} from "../adapters/types.js";
import { asBusError, BusError } from "./errors.js";
import {
  assertProtocolVersion,
  encodeFrame,
  FrameDecoder,
  parseFrame
} from "./protocol.js";
import {
  BUS_CAPABILITIES,
  BUS_PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  type AdapterDocumentListParams,
  type AdapterDocumentReadParams,
  type AdapterDocumentWriteParams,
  type AdapterEventsReadParams,
  type AdapterWorkspaceListParams,
  type AgentIdentity,
  type BusCapability,
  type BusErrorPayload,
  type BusEvent,
  type BusMethod,
  type BusParams,
  type BusRequestMap,
  type BusResult,
  type ConnectionGrant,
  type EventPublishParams,
  type EventSubscribeParams,
  type WorkspaceListParams,
  type WorkspaceReadParams,
  type WorkspaceWriteParams
} from "./types.js";
import {
  validateSessionId,
  WorkspaceStore,
  type RegisterWorkspaceOptions
} from "./workspace.js";

export type BusConnectionInfo = {
  agentId: string;
  capabilities: readonly BusCapability[];
  sessionIds: readonly string[];
};

export type BusAuthorizer = (
  identity: AgentIdentity
) => ConnectionGrant | null | Promise<ConnectionGrant | null>;

export type ApplicationAdapterResolver = (
  sessionId: string
) => ApplicationAdapter | undefined;

export type InitialWorkspace = RegisterWorkspaceOptions & {
  sessionId: string;
  root: string;
};

export type BusServerOptions = {
  socketPath: string;
  authorize: BusAuthorizer;
  adapterResolver?: ApplicationAdapterResolver;
  workspaces?: readonly InitialWorkspace[];
  maxFrameBytes?: number;
  maxFileBytes?: number;
  maxListEntries?: number;
  handshakeTimeoutMs?: number;
};

type Subscription = EventSubscribeParams & {
  subscriptionId: string;
  connection: BusConnection;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000;
const VALID_CAPABILITIES = new Set<string>(BUS_CAPABILITIES);

function validateChannel(channel: unknown): string {
  if (
    typeof channel !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(channel)
  ) {
    throw new BusError("INVALID_CHANNEL", "Invalid event channel");
  }
  return channel;
}

function validateIdentity(identity: unknown): AgentIdentity {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    throw new BusError("INVALID_IDENTITY", "Agent identity must be an object");
  }

  const candidate = identity as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(candidate.id)
  ) {
    throw new BusError("INVALID_IDENTITY", "Invalid agent ID");
  }
  if (
    candidate.token !== undefined &&
    (typeof candidate.token !== "string" || candidate.token.length > 4096)
  ) {
    throw new BusError("INVALID_IDENTITY", "Invalid agent token");
  }

  return {
    id: candidate.id,
    ...(candidate.token === undefined ? {} : { token: candidate.token })
  };
}

function validateGrant(grant: ConnectionGrant): ConnectionGrant {
  if (
    typeof grant !== "object" ||
    grant === null ||
    !Array.isArray(grant.capabilities) ||
    !Array.isArray(grant.sessionIds) ||
    grant.capabilities.some(capability => !VALID_CAPABILITIES.has(capability)) ||
    grant.sessionIds.some(sessionId => {
      try {
        validateSessionId(sessionId);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new BusError("INVALID_GRANT", "Authorizer returned an invalid grant");
  }

  return {
    capabilities: [...new Set(grant.capabilities)],
    sessionIds: [...new Set(grant.sessionIds)]
  };
}

function errorPayload(error: unknown): BusErrorPayload {
  return error instanceof BusError
    ? error.toJSON()
    : new BusError("INTERNAL_ERROR", "Request failed").toJSON();
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BusError("INVALID_REQUEST", `${name} must be a non-empty string`);
  }
  return value;
}

function adapterFailure(error: unknown): BusError {
  if (!(error instanceof AdapterError)) {
    return asBusError(error);
  }

  const details = typeof error.details === "object" &&
    error.details !== null &&
    !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : error.details === undefined
      ? undefined
      : { value: error.details };
  return new BusError(error.code, error.message, details);
}

export class BusServer {
  readonly socketPath: string;
  readonly maxFrameBytes: number;
  readonly workspaces: WorkspaceStore;

  readonly authorize: BusAuthorizer;
  private readonly adapterResolver?: ApplicationAdapterResolver;
  private readonly initialWorkspaces: readonly InitialWorkspace[];
  readonly handshakeTimeoutMs: number;
  private readonly server: Server;
  private readonly connections = new Set<BusConnection>();
  private readonly subscriptions = new Map<string, Subscription>();
  private socketIdentity?: { dev: number; ino: number };

  constructor(options: BusServerOptions) {
    if (typeof options.socketPath !== "string" || options.socketPath.length === 0) {
      throw new TypeError("socketPath must be a non-empty string");
    }
    if (typeof options.authorize !== "function") {
      throw new TypeError("authorize must be a function");
    }
    if (
      options.adapterResolver !== undefined &&
      typeof options.adapterResolver !== "function"
    ) {
      throw new TypeError("adapterResolver must be a function");
    }

    this.socketPath = options.socketPath;
    this.authorize = options.authorize;
    this.adapterResolver = options.adapterResolver;
    this.initialWorkspaces = options.workspaces ?? [];
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ??
      DEFAULT_HANDSHAKE_TIMEOUT_MS;

    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 256) {
      throw new TypeError("maxFrameBytes must be a safe integer of at least 256");
    }
    if (
      !Number.isSafeInteger(this.handshakeTimeoutMs) ||
      this.handshakeTimeoutMs < 1
    ) {
      throw new TypeError("handshakeTimeoutMs must be a positive safe integer");
    }

    this.workspaces = new WorkspaceStore({
      ...(options.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxListEntries === undefined
        ? {}
        : { maxListEntries: options.maxListEntries })
    });
    this.server = createServer(socket => {
      const connection = new BusConnection(this, socket);
      this.connections.add(connection);
      connection.closed.finally(() => this.connections.delete(connection));
    });
  }

  get listening(): boolean {
    return this.server.listening;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  getConnections(): BusConnectionInfo[] {
    return [...this.connections]
      .filter(connection => connection.info !== undefined)
      .map(connection => connection.info as BusConnectionInfo);
  }

  async listen(): Promise<void> {
    if (this.server.listening) {
      throw new BusError("ALREADY_LISTENING", "Bus server is already listening");
    }

    for (const workspace of this.initialWorkspaces) {
      await this.registerSession(workspace.sessionId, workspace.root, {
        create: workspace.create
      });
    }
    await this.prepareSocketPath();

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      this.server.once("error", onError);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", onError);
        resolveListen();
      });
    });

    await chmod(this.socketPath, 0o600);
    const socketStat = await lstat(this.socketPath);
    this.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.close();
    }

    if (this.server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        this.server.close(error => {
          if (error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
      });
    }

    await this.removeOwnedSocket();
  }

  async registerSession(
    sessionId: string,
    root: string,
    options: RegisterWorkspaceOptions = {}
  ): Promise<string> {
    return this.workspaces.registerSession(sessionId, root, options);
  }

  unregisterSession(sessionId: string): boolean {
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.sessionId === sessionId) {
        this.subscriptions.delete(subscriptionId);
        subscription.connection.removeSubscription(subscriptionId);
      }
    }
    return this.workspaces.unregisterSession(sessionId);
  }

  async publish(
    sessionId: string,
    channel: string,
    data: unknown,
    publisherId = "server"
  ): Promise<BusEvent> {
    validateSessionId(sessionId);
    validateChannel(channel);
    if (!this.workspaces.hasSession(sessionId)) {
      throw new BusError("SESSION_NOT_FOUND", "Session workspace is not registered");
    }

    const event: BusEvent = {
      id: randomUUID(),
      sessionId,
      channel,
      data,
      publisherId,
      publishedAt: new Date().toISOString()
    };
    encodeFrame({
      version: BUS_PROTOCOL_VERSION,
      type: "event",
      event
    }, this.maxFrameBytes);

    for (const subscription of this.subscriptions.values()) {
      if (
        subscription.sessionId === sessionId &&
        (subscription.channel === undefined || subscription.channel === channel)
      ) {
        subscription.connection.deliver(event);
      }
    }

    return event;
  }

  requireCapability(connection: BusConnection, capability: BusCapability): void {
    if (!connection.hasCapability(capability)) {
      throw new BusError(
        "CAPABILITY_DENIED",
        `Capability ${capability} is not granted`,
        { capability }
      );
    }
  }

  requireSession(connection: BusConnection, sessionId: unknown): string {
    const validSessionId = validateSessionId(sessionId);
    if (!connection.hasSession(validSessionId)) {
      throw new BusError(
        "SESSION_FORBIDDEN",
        "Session is not granted to this connection",
        { sessionId: validSessionId }
      );
    }
    if (!this.workspaces.hasSession(validSessionId)) {
      throw new BusError("SESSION_NOT_FOUND", "Session workspace is not registered");
    }
    return validSessionId;
  }

  private requireAdapter(
    connection: BusConnection,
    requestedSessionId: unknown
  ): { adapter: ApplicationAdapter; agent: AdapterAgentIdentity } {
    const sessionId = validateSessionId(requestedSessionId);
    if (!connection.hasSession(sessionId)) {
      throw new BusError(
        "SESSION_FORBIDDEN",
        "Session is not granted to this connection",
        { sessionId }
      );
    }

    const adapter = this.adapterResolver?.(sessionId);
    if (adapter === undefined) {
      throw new BusError(
        "ADAPTER_NOT_AVAILABLE",
        "No application adapter is available for this session",
        { sessionId }
      );
    }
    return {
      adapter,
      agent: { agentId: connection.agentId as string, sessionId }
    };
  }

  private async delegate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw adapterFailure(error);
    }
  }

  async dispatch<M extends BusMethod>(
    connection: BusConnection,
    method: M,
    params: BusParams<M>
  ): Promise<BusResult<M>> {
    switch (method) {
      case "ping":
        return { now: new Date().toISOString() } as BusResult<M>;
      case "workspace.read": {
        this.requireCapability(connection, "workspace:read");
        const request = params as WorkspaceReadParams;
        const sessionId = this.requireSession(connection, request.sessionId);
        return await this.workspaces.read(
          sessionId,
          request.path,
          request.encoding
        ) as BusResult<M>;
      }
      case "workspace.write": {
        this.requireCapability(connection, "workspace:write");
        const request = params as WorkspaceWriteParams;
        const sessionId = this.requireSession(connection, request.sessionId);
        return await this.workspaces.write(
          sessionId,
          request.path,
          request.content,
          request.encoding,
          request.expectedVersion
        ) as BusResult<M>;
      }
      case "workspace.list": {
        this.requireCapability(connection, "workspace:list");
        const request = params as WorkspaceListParams;
        const sessionId = this.requireSession(connection, request.sessionId);
        return await this.workspaces.list(sessionId, request.path) as BusResult<M>;
      }
      case "event.publish": {
        this.requireCapability(connection, "events:publish");
        const request = params as EventPublishParams;
        const sessionId = this.requireSession(connection, request.sessionId);
        const event = await this.publish(
          sessionId,
          request.channel,
          request.data,
          connection.agentId as string
        );
        return { event } as BusResult<M>;
      }
      case "event.subscribe": {
        this.requireCapability(connection, "events:subscribe");
        const request = params as EventSubscribeParams;
        const sessionId = this.requireSession(connection, request.sessionId);
        const channel = request.channel === undefined
          ? undefined
          : validateChannel(request.channel);
        const subscription: Subscription = {
          subscriptionId: randomUUID(),
          sessionId,
          ...(channel === undefined ? {} : { channel }),
          connection
        };
        this.subscriptions.set(subscription.subscriptionId, subscription);
        connection.addSubscription(subscription.subscriptionId);
        return {
          subscriptionId: subscription.subscriptionId,
          sessionId,
          ...(channel === undefined ? {} : { channel })
        } as BusResult<M>;
      }
      case "event.unsubscribe": {
        this.requireCapability(connection, "events:subscribe");
        const subscriptionId = (params as { subscriptionId?: unknown }).subscriptionId;
        if (typeof subscriptionId !== "string") {
          throw new BusError("INVALID_REQUEST", "subscriptionId must be a string");
        }
        const subscription = this.subscriptions.get(subscriptionId);
        const removed = subscription?.connection === connection;
        if (removed) {
          this.subscriptions.delete(subscriptionId);
          connection.removeSubscription(subscriptionId);
        }
        return { subscriptionId, removed } as BusResult<M>;
      }
      case "adapter.workspace.list": {
        this.requireCapability(connection, "adapter:workspace:list");
        const request = params as AdapterWorkspaceListParams;
        const { adapter, agent } = this.requireAdapter(connection, request.sessionId);
        return {
          workspaces: await this.delegate(() => adapter.listWorkspaces(agent))
        } as BusResult<M>;
      }
      case "adapter.document.list": {
        this.requireCapability(connection, "adapter:document:list");
        const request = params as AdapterDocumentListParams;
        const { adapter, agent } = this.requireAdapter(connection, request.sessionId);
        const workspaceId = requiredString(request.workspaceId, "workspaceId");
        return {
          documents: await this.delegate(() => adapter.listDocuments(agent, workspaceId))
        } as BusResult<M>;
      }
      case "adapter.document.read": {
        this.requireCapability(connection, "adapter:document:read");
        const request = params as AdapterDocumentReadParams;
        const { adapter, agent } = this.requireAdapter(connection, request.sessionId);
        const workspaceId = requiredString(request.workspaceId, "workspaceId");
        const path = requiredString(request.path, "path");
        return {
          document: await this.delegate(() => adapter.readDocument(
            agent,
            workspaceId,
            path
          ))
        } as BusResult<M>;
      }
      case "adapter.document.write": {
        this.requireCapability(connection, "adapter:document:write");
        const request = params as AdapterDocumentWriteParams;
        const { adapter, agent } = this.requireAdapter(connection, request.sessionId);
        const workspaceId = requiredString(request.workspaceId, "workspaceId");
        const path = requiredString(request.path, "path");
        if (typeof request.text !== "string") {
          throw new BusError("INVALID_REQUEST", "text must be a string");
        }
        if (
          !Number.isSafeInteger(request.expectedVersion) ||
          request.expectedVersion < 1
        ) {
          throw new BusError(
            "INVALID_REQUEST",
            "expectedVersion must be a positive integer"
          );
        }
        return {
          document: await this.delegate(() => adapter.writeDocument(
            agent,
            workspaceId,
            path,
            request.text,
            { expectedVersion: request.expectedVersion }
          ))
        } as BusResult<M>;
      }
      case "adapter.events.read": {
        this.requireCapability(connection, "adapter:events:read");
        const request = params as AdapterEventsReadParams;
        const { adapter, agent } = this.requireAdapter(connection, request.sessionId);
        const options: ReadEventsOptions = {};
        if (request.after !== undefined) {
          if (!Number.isSafeInteger(request.after) || request.after < 0) {
            throw new BusError(
              "INVALID_REQUEST",
              "after must be a non-negative integer"
            );
          }
          options.after = request.after;
        }
        if (request.limit !== undefined) {
          if (
            !Number.isSafeInteger(request.limit) ||
            request.limit < 1 ||
            request.limit > 200
          ) {
            throw new BusError(
              "INVALID_REQUEST",
              "limit must be an integer between 1 and 200"
            );
          }
          options.limit = request.limit;
        }
        return await this.delegate(
          () => adapter.getEvents(agent, options)
        ) as BusResult<M>;
      }
      default:
        throw new BusError("METHOD_NOT_FOUND", `Unknown method ${String(method)}`);
    }
  }

  removeConnectionSubscriptions(connection: BusConnection): void {
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.connection === connection) {
        this.subscriptions.delete(subscriptionId);
      }
    }
  }

  private async prepareSocketPath(): Promise<void> {
    try {
      const existing = await lstat(this.socketPath);
      if (!existing.isSocket()) {
        throw new BusError(
          "SOCKET_PATH_INVALID",
          "Socket path exists and is not a Unix socket"
        );
      }
      if (await this.socketIsActive()) {
        throw new BusError("SOCKET_IN_USE", "Unix socket is already in use");
      }
      await unlink(this.socketPath);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
  }

  private socketIsActive(): Promise<boolean> {
    return new Promise((resolveActive, rejectActive) => {
      const socket = createConnection(this.socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolveActive(true);
      });
      socket.once("error", error => {
        if ("code" in error && error.code === "ECONNREFUSED") {
          resolveActive(false);
        } else {
          rejectActive(error);
        }
      });
    });
  }

  private async removeOwnedSocket(): Promise<void> {
    if (this.socketIdentity === undefined) {
      return;
    }

    try {
      const socketStat = await lstat(this.socketPath);
      if (
        socketStat.isSocket() &&
        socketStat.dev === this.socketIdentity.dev &&
        socketStat.ino === this.socketIdentity.ino
      ) {
        await unlink(this.socketPath);
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    } finally {
      this.socketIdentity = undefined;
    }
  }
}

class BusConnection {
  readonly closed: Promise<void>;
  info?: BusConnectionInfo;
  agentId?: string;

  private readonly decoder: FrameDecoder;
  private readonly handshakeTimer: NodeJS.Timeout;
  private readonly subscriptions = new Set<string>();
  private readonly inFlight = new Set<string>();
  private closedResolve!: () => void;
  private processing = Promise.resolve();
  private closing = false;
  private ready = false;
  private grant?: ConnectionGrant;
  private outgoingFrameBytes: number;

  constructor(
    private readonly owner: BusServer,
    private readonly socket: Socket
  ) {
    this.outgoingFrameBytes = owner.maxFrameBytes;
    this.decoder = new FrameDecoder(owner.maxFrameBytes);
    this.closed = new Promise(resolveClosed => {
      this.closedResolve = resolveClosed;
    });
    this.handshakeTimer = setTimeout(() => {
      this.fail(new BusError("HANDSHAKE_TIMEOUT", "Handshake timed out"));
    }, owner.handshakeTimeoutMs);
    this.handshakeTimer.unref();

    socket.on("data", chunk => {
      this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    socket.on("error", () => this.close());
    socket.on("close", () => {
      this.closing = true;
      clearTimeout(this.handshakeTimer);
      owner.removeConnectionSubscriptions(this);
      this.closedResolve();
    });
  }

  receive(chunk: Buffer): void {
    if (this.closing) {
      return;
    }

    try {
      this.decoder.push(chunk, frame => {
        this.processing = this.processing
          .then(() => this.processFrame(frame))
          .catch((error: unknown) => this.fail(error));
      });
    } catch (error) {
      this.fail(error);
    }
  }

  hasCapability(capability: BusCapability): boolean {
    return this.grant?.capabilities.includes(capability) === true;
  }

  hasSession(sessionId: string): boolean {
    return this.grant?.sessionIds.includes(sessionId) === true;
  }

  addSubscription(subscriptionId: string): void {
    this.subscriptions.add(subscriptionId);
  }

  removeSubscription(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }

  deliver(event: BusEvent): void {
    if (this.closing || !this.ready) {
      return;
    }

    try {
      this.send({ version: BUS_PROTOCOL_VERSION, type: "event", event });
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    clearTimeout(this.handshakeTimer);
    this.socket.destroy();
  }

  private async processFrame(frame: Buffer): Promise<void> {
    if (this.closing) {
      return;
    }

    const message = parseFrame(frame);
    assertProtocolVersion(message);

    if (!this.ready) {
      if (message.type !== "hello") {
        throw new BusError("HANDSHAKE_REQUIRED", "Hello must be the first message");
      }
      await this.handshake(message);
      return;
    }

    if (message.type !== "request") {
      throw new BusError("INVALID_MESSAGE", "Expected a request message");
    }
    await this.handleRequest(message);
  }

  private async handshake(message: Record<string, unknown>): Promise<void> {
    const identity = validateIdentity(message.agent);
    let grant: ConnectionGrant | null;
    try {
      grant = await this.owner.authorize(identity);
    } catch {
      throw new BusError("AUTH_FAILED", "Agent authentication failed");
    }
    if (grant === null) {
      throw new BusError("AUTH_FAILED", "Agent authentication failed");
    }

    this.grant = validateGrant(grant);
    this.agentId = identity.id;
    this.info = {
      agentId: identity.id,
      capabilities: this.grant.capabilities,
      sessionIds: this.grant.sessionIds
    };
    clearTimeout(this.handshakeTimer);

    if (message.maxFrameBytes !== undefined) {
      if (
        !Number.isSafeInteger(message.maxFrameBytes) ||
        (message.maxFrameBytes as number) < 256
      ) {
        throw new BusError("INVALID_FRAME_LIMIT", "Invalid client frame limit");
      }
      this.outgoingFrameBytes = Math.min(
        this.owner.maxFrameBytes,
        message.maxFrameBytes as number
      );
    }

    this.ready = true;
    this.send({
      version: BUS_PROTOCOL_VERSION,
      type: "welcome",
      agentId: identity.id,
      capabilities: this.grant.capabilities,
      sessionIds: this.grant.sessionIds,
      maxFrameBytes: this.outgoingFrameBytes,
      protocolVersion: BUS_PROTOCOL_VERSION
    });
  }

  private async handleRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      throw new BusError("INVALID_REQUEST", "Request ID must be a short string");
    }
    if (this.inFlight.has(id)) {
      throw new BusError("DUPLICATE_REQUEST_ID", "Request ID is already in flight");
    }
    if (typeof message.method !== "string") {
      throw new BusError("INVALID_REQUEST", "Request method must be a string");
    }
    if (
      typeof message.params !== "object" ||
      message.params === null ||
      Array.isArray(message.params)
    ) {
      throw new BusError("INVALID_REQUEST", "Request params must be an object");
    }

    this.inFlight.add(id);
    try {
      const result = await this.owner.dispatch(
        this,
        message.method as BusMethod,
        message.params as BusParams<BusMethod>
      );
      this.sendResponse(id, true, result);
    } catch (error) {
      this.sendResponse(id, false, errorPayload(error));
    } finally {
      this.inFlight.delete(id);
    }
  }

  private sendResponse(
    id: string,
    ok: boolean,
    payload: unknown
  ): void {
    if (this.closing) {
      return;
    }

    try {
      this.send(ok
        ? { version: BUS_PROTOCOL_VERSION, type: "response", id, ok, result: payload }
        : { version: BUS_PROTOCOL_VERSION, type: "response", id, ok, error: payload });
    } catch (error) {
      if (ok && error instanceof BusError) {
        this.send({
          version: BUS_PROTOCOL_VERSION,
          type: "response",
          id,
          ok: false,
          error: new BusError(
            error.code === "FRAME_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : "INVALID_RESPONSE",
            error.message,
            error.details
          ).toJSON()
        });
      } else {
        this.close();
      }
    }
  }

  private send(message: unknown): void {
    const frame = encodeFrame(message, this.outgoingFrameBytes);
    this.socket.write(frame);
    if (this.socket.writableLength > this.owner.maxFrameBytes * 4) {
      throw new BusError("BACKPRESSURE_LIMIT", "Connection write buffer is full");
    }
  }

  private fail(error: unknown): void {
    if (this.closing) {
      return;
    }

    const normalized = asBusError(error);
    try {
      const frame = encodeFrame({
        version: BUS_PROTOCOL_VERSION,
        type: "error",
        error: normalized.toJSON()
      }, this.outgoingFrameBytes);
      this.socket.write(frame);
    } catch {
      // The peer may already have closed the socket.
    }
    this.closing = true;
    clearTimeout(this.handshakeTimer);
    this.socket.end();
  }
}
