import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, Server, Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  AdapterError,
  DocumentConflictError,
  ExtensionNotConnectedError
} from "./errors.js";
import {
  AdapterEvent,
  AdapterEventType,
  AgentIdentity,
  ApplicationAdapter,
  assertAgentIdentity,
  DocumentDescriptor,
  DocumentSnapshot,
  EventPage,
  ReadEventsOptions,
  WorkspaceInfo,
  WriteDocumentOptions
} from "./types.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_BUFFER_SIZE = 1_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function bridgeDebug(message: string): void {
  if (process.env.CLOUD_AI_OS_DEBUG_BRIDGE === "1") {
    console.error(`[syntrum:adapter] ${message}`);
  }
}

interface WorkspaceConfiguration {
  id: string;
  name?: string;
  rootPath: string;
}

export interface VSCodeAdapterOptions {
  workspaces: WorkspaceConfiguration[];
  socketPath?: string;
  authToken?: string;
  requestTimeoutMs?: number;
  eventBufferSize?: number;
}

interface WorkspaceRecord extends WorkspaceConfiguration {
  rootPath: string;
  name: string;
}

interface ConnectionState {
  socket: Socket;
  ready: boolean;
  workspaceIds: Set<string>;
  buffer: string;
  handshakeTimer: NodeJS.Timeout;
}

interface PendingRequest {
  connection: ConnectionState;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface BridgeRequest {
  type: "request";
  id: string;
  operation: "document.list" | "document.read" | "document.write";
  workspaceId: string;
  path?: string;
  agent: AgentIdentity;
  text?: string;
  expectedVersion?: number;
}

interface RemoteError {
  message: string;
  code: string;
  details?: unknown;
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function normalizeDocumentPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    isAbsolute(path)
  ) {
    throw new AdapterError(
      "Document path must be a nonempty workspace-relative path",
      "INVALID_DOCUMENT_PATH"
    );
  }

  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const resolved = resolve("/", normalized);
  const canonical = relative("/", resolved).replaceAll(sep, "/");

  if (
    canonical.length === 0 ||
    canonical === ".." ||
    canonical.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new AdapterError(
      "Document path escapes the workspace",
      "INVALID_DOCUMENT_PATH"
    );
  }

  return canonical;
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

function isAgentIdentity(value: unknown): value is AgentIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const agent = value as Partial<AgentIdentity>;
  return typeof agent.agentId === "string" &&
    IDENTIFIER.test(agent.agentId) &&
    typeof agent.sessionId === "string" &&
    IDENTIFIER.test(agent.sessionId);
}

function isSnapshot(value: unknown): value is DocumentSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<DocumentSnapshot>;
  return typeof snapshot.workspaceId === "string" &&
    typeof snapshot.path === "string" &&
    typeof snapshot.text === "string" &&
    Number.isSafeInteger(snapshot.version) &&
    typeof snapshot.languageId === "string" &&
    typeof snapshot.dirty === "boolean" &&
    (snapshot.eol === "lf" || snapshot.eol === "crlf");
}

export class VSCodeAdapter implements ApplicationAdapter {
  readonly application = "vscode";

  private readonly configuredWorkspaces: WorkspaceConfiguration[];
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly connections = new Set<ConnectionState>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private readonly connectionWaiters = new Map<string, Set<{
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>>();
  private readonly requestTimeoutMs: number;
  private readonly eventBufferSize: number;
  private readonly requestedSocketPath?: string;
  private readonly requestedAuthToken?: string;
  private server?: Server;
  private socketPath?: string;
  private socketIdentity?: { dev: number; ino: number };
  private authToken?: string;
  private events: AdapterEvent[] = [];
  private nextEventId = 0;
  private eventResetAfter = 0;

  constructor(options: VSCodeAdapterOptions) {
    if (!Array.isArray(options.workspaces) || options.workspaces.length === 0) {
      throw new TypeError("At least one workspace must be configured");
    }

    const ids = new Set<string>();
    for (const workspace of options.workspaces) {
      if (!IDENTIFIER.test(workspace.id)) {
        throw new TypeError(`Invalid workspace identifier '${workspace.id}'`);
      }
      if (ids.has(workspace.id)) {
        throw new TypeError(`Duplicate workspace identifier '${workspace.id}'`);
      }
      if (!isAbsolute(workspace.rootPath)) {
        throw new TypeError("Workspace root paths must be absolute");
      }
      ids.add(workspace.id);
    }

    if (
      options.authToken !== undefined &&
      (options.authToken.length < 16 || options.authToken.length > 512)
    ) {
      throw new TypeError("The bridge auth token must be 16-512 characters");
    }

    this.configuredWorkspaces = options.workspaces.map(item => ({ ...item }));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.eventBufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE;
    this.requestedSocketPath = options.socketPath;
    this.requestedAuthToken = options.authToken;

    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.eventBufferSize) || this.eventBufferSize < 1) {
      throw new TypeError("eventBufferSize must be a positive integer");
    }
  }

  get connectionInfo(): {
    protocolVersion: number;
    socketPath: string;
    authToken: string;
  } {
    if (!this.socketPath || !this.authToken) {
      throw new AdapterError("The adapter has not been started", "NOT_STARTED");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      socketPath: this.socketPath,
      authToken: this.authToken
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new AdapterError("The adapter is already started", "ALREADY_STARTED");
    }

    this.workspaces.clear();
    for (const configuration of this.configuredWorkspaces) {
      const rootPath = await realpath(configuration.rootPath);
      if (!(await stat(rootPath)).isDirectory()) {
        throw new AdapterError(
          `Workspace '${configuration.id}' is not a directory`,
          "INVALID_WORKSPACE"
        );
      }
      this.workspaces.set(configuration.id, {
        ...configuration,
        rootPath,
        name: configuration.name ?? configuration.id
      });
    }

    const firstWorkspace = this.workspaces.values().next().value!;
    const requestedSocket = this.requestedSocketPath
      ? resolve(firstWorkspace.rootPath, this.requestedSocketPath)
      : resolve(firstWorkspace.rootPath, ".cloud-ai-os/vscode-adapter.sock");
    await mkdir(dirname(requestedSocket), { recursive: true, mode: 0o700 });
    const socketDirectory = await realpath(dirname(requestedSocket));
    const workspaceRoots = Array.from(this.workspaces.values(), item => item.rootPath);
    const explicitExternalSocket = this.requestedSocketPath !== undefined &&
      isAbsolute(this.requestedSocketPath);
    if (!explicitExternalSocket && !workspaceRoots.some(root => isInside(root, socketDirectory))) {
      throw new AdapterError(
        "The bridge socket must be inside a configured workspace",
        "INVALID_SOCKET_PATH"
      );
    }

    this.socketPath = resolve(socketDirectory, requestedSocket.split(sep).at(-1)!);
    this.authToken = this.requestedAuthToken ?? randomBytes(32).toString("base64url");

    const server = createServer(socket => this.acceptConnection(socket));
    this.server = server;

    try {
      bridgeDebug(`listening for extension on ${this.socketPath} (${this.socketPath.length} chars)`);
      await this.prepareSocketPath();
      this.events = [];
      this.eventResetAfter = this.nextEventId;
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => rejectListen(error);
        server.once("error", onError);
        server.listen(this.socketPath!, () => {
          server.off("error", onError);
          resolveListen();
        });
      });
      const socketStat = await lstat(this.socketPath);
      this.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
      const { chmod } = await import("node:fs/promises");
      await chmod(this.socketPath, 0o600);
      bridgeDebug("socket server is ready");
    } catch (error) {
      bridgeDebug(`socket startup failed: ${error instanceof Error ? error.message : String(error)}`);
      this.server = undefined;
      if (server.listening) {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      }
      await this.removeOwnedSocket();
      this.socketPath = undefined;
      this.authToken = undefined;
      this.workspaces.clear();
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;

    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    for (const waiters of this.connectionWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new AdapterError("The adapter was closed", "ADAPTER_CLOSED"));
      }
    }
    this.connectionWaiters.clear();

    try {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      await this.removeOwnedSocket();
    } finally {
      this.socketPath = undefined;
      this.authToken = undefined;
      this.workspaces.clear();
    }
  }

  async listWorkspaces(agent: AgentIdentity): Promise<WorkspaceInfo[]> {
    assertAgentIdentity(agent);
    this.assertStarted();
    return Array.from(this.workspaces.values(), workspace => ({
      id: workspace.id,
      name: workspace.name,
      connected: this.findConnection(workspace.id) !== undefined
    }));
  }

  isWorkspaceConnected(workspaceId: string): boolean {
    return this.findConnection(workspaceId) !== undefined;
  }

  async listDocuments(
    agent: AgentIdentity,
    workspaceId: string
  ): Promise<DocumentDescriptor[]> {
    assertAgentIdentity(agent);
    const result = await this.request({
      type: "request",
      id: "",
      operation: "document.list",
      workspaceId,
      agent
    });
    if (!Array.isArray(result)) {
      throw new AdapterError("Invalid document list from extension", "INVALID_RESPONSE");
    }
    return result as DocumentDescriptor[];
  }

  async readDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string
  ): Promise<DocumentSnapshot> {
    assertAgentIdentity(agent);
    const canonicalPath = await this.canonicalDocumentPath(workspaceId, path);
    const result = await this.request({
      type: "request",
      id: "",
      operation: "document.read",
      workspaceId,
      path: canonicalPath,
      agent
    });
    return this.validateSnapshot(result, workspaceId);
  }

  async writeDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot> {
    assertAgentIdentity(agent);
    if (typeof text !== "string") {
      throw new TypeError("Document text must be a string");
    }
    if (!Number.isSafeInteger(options?.expectedVersion) || options.expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }

    const canonicalPath = await this.canonicalDocumentPath(workspaceId, path);
    const result = await this.request({
      type: "request",
      id: "",
      operation: "document.write",
      workspaceId,
      path: canonicalPath,
      agent,
      text,
      expectedVersion: options.expectedVersion
    });
    return this.validateSnapshot(result, workspaceId);
  }

  async getEvents(
    agent: AgentIdentity,
    options: ReadEventsOptions = {}
  ): Promise<EventPage> {
    assertAgentIdentity(agent);
    const after = options.after ?? 0;
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("after must be a nonnegative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError("limit must be an integer between 1 and 200");
    }

    const oldestEventId = this.events[0]?.id ?? 0;
    const events = this.events.filter(event => event.id > after).slice(0, limit);
    return {
      events,
      nextEventId: events.at(-1)?.id ?? after,
      oldestEventId,
      reset: after > this.nextEventId || (
        oldestEventId > 0
          ? after < oldestEventId - 1
          : after < this.eventResetAfter
      )
    };
  }

  onEvent(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitForWorkspace(workspaceId: string, timeoutMs = 10_000): Promise<void> {
    this.assertStarted();
    this.getWorkspace(workspaceId);
    if (this.findConnection(workspaceId)) {
      return;
    }

    await new Promise<void>((resolveWait, rejectWait) => {
      const waiter = {
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          this.connectionWaiters.get(workspaceId)?.delete(waiter);
          rejectWait(new AdapterError(
            `Timed out waiting for workspace '${workspaceId}'`,
            "CONNECTION_TIMEOUT"
          ));
        }, timeoutMs)
      };
      const waiters = this.connectionWaiters.get(workspaceId) ?? new Set();
      waiters.add(waiter);
      this.connectionWaiters.set(workspaceId, waiters);
    });
  }

  private async prepareSocketPath(): Promise<void> {
    try {
      const existing = await lstat(this.socketPath!);
      if (!existing.isSocket()) {
        throw new AdapterError(
          "Socket path exists and is not a Unix socket",
          "SOCKET_PATH_INVALID"
        );
      }
      if (await this.socketIsActive()) {
        throw new AdapterError("Unix socket is already in use", "SOCKET_IN_USE");
      }
      await unlink(this.socketPath!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private socketIsActive(): Promise<boolean> {
    return new Promise((resolveActive, rejectActive) => {
      const socket = createConnection(this.socketPath!);
      socket.once("connect", () => {
        socket.destroy();
        resolveActive(true);
      });
      socket.once("error", error => {
        if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          resolveActive(false);
        } else {
          rejectActive(error);
        }
      });
    });
  }

  private async removeOwnedSocket(): Promise<void> {
    if (!this.socketIdentity || !this.socketPath) {
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    } finally {
      this.socketIdentity = undefined;
    }
  }

  private assertStarted(): void {
    if (!this.server) {
      throw new AdapterError("The adapter has not been started", "NOT_STARTED");
    }
  }

  private getWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new AdapterError(
        `Unknown workspace '${workspaceId}'`,
        "UNKNOWN_WORKSPACE",
        { workspaceId }
      );
    }
    return workspace;
  }

  private async canonicalDocumentPath(
    workspaceId: string,
    path: string
  ): Promise<string> {
    this.assertStarted();
    const workspace = this.getWorkspace(workspaceId);
    const normalized = normalizeDocumentPath(path);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolve(workspace.rootPath, normalized));
    } catch {
      throw new AdapterError(
        `Document '${normalized}' does not exist`,
        "DOCUMENT_NOT_FOUND",
        { workspaceId, path: normalized }
      );
    }
    if (
      canonicalPath === workspace.rootPath ||
      !isInside(workspace.rootPath, canonicalPath) ||
      !(await stat(canonicalPath)).isFile()
    ) {
      throw new AdapterError(
        "Document must be a file inside the workspace",
        "INVALID_DOCUMENT_PATH",
        { workspaceId, path: normalized }
      );
    }
    return relative(workspace.rootPath, canonicalPath).replaceAll(sep, "/");
  }

  private validateSnapshot(value: unknown, workspaceId: string): DocumentSnapshot {
    if (!isSnapshot(value) || value.workspaceId !== workspaceId) {
      throw new AdapterError("Invalid document response from extension", "INVALID_RESPONSE");
    }
    return value;
  }

  private findConnection(workspaceId: string): ConnectionState | undefined {
    return Array.from(this.connections).find(
      connection => connection.ready && connection.workspaceIds.has(workspaceId)
    );
  }

  private async request<T>(request: BridgeRequest): Promise<T> {
    this.assertStarted();
    const workspace = this.getWorkspace(request.workspaceId);
    const connection = this.findConnection(workspace.id);
    if (!connection) {
      throw new ExtensionNotConnectedError(workspace.id);
    }

    const id = randomUUID();
    const message = { ...request, id };
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new AdapterError(
          `VS Code request '${request.operation}' timed out`,
          "REQUEST_TIMEOUT"
        ));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        connection,
        resolve: value => resolveRequest(value as T),
        reject: rejectRequest,
        timer
      });
      connection.socket.write(`${JSON.stringify(message)}\n`, error => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            rejectRequest(error);
          }
        }
      });
    });
  }

  private acceptConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    const connection: ConnectionState = {
      socket,
      ready: false,
      workspaceIds: new Set(),
      buffer: "",
      handshakeTimer: setTimeout(() => socket.destroy(), 5_000)
    };
    this.connections.add(connection);
    bridgeDebug("extension socket connected");

    socket.on("data", (chunk: string) => {
      connection.buffer += chunk;
      if (Buffer.byteLength(connection.buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = connection.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            this.handleMessage(connection, JSON.parse(line));
          } catch (error) {
            bridgeDebug(`message rejected: ${error instanceof Error ? error.message : String(error)}`);
            socket.destroy();
            return;
          }
        }
        newline = connection.buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      bridgeDebug(`extension socket closed (ready=${connection.ready})`);
      clearTimeout(connection.handshakeTimer);
      this.connections.delete(connection);
      for (const [id, pending] of this.pending) {
        if (pending.connection === connection) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new AdapterError(
            "The VS Code extension disconnected",
            "EXTENSION_DISCONNECTED"
          ));
        }
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private handleMessage(connection: ConnectionState, message: unknown): void {
    if (!message || typeof message !== "object") {
      throw new TypeError("Invalid bridge message");
    }
    const record = message as Record<string, unknown>;

    if (!connection.ready) {
      if (record.type !== "hello") {
        throw new TypeError("Expected bridge handshake");
      }
      this.completeHandshake(connection, record);
      return;
    }

    if (record.type === "response") {
      if (typeof record.id !== "string") {
        throw new TypeError("Invalid bridge response");
      }
      const pending = this.pending.get(record.id);
      if (!pending || pending.connection !== connection) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(record.id);

      if (record.error) {
        const remoteError = record.error as RemoteError;
        if (
          remoteError.code === "VERSION_CONFLICT" &&
          remoteError.details &&
          isSnapshot((remoteError.details as { current?: unknown }).current)
        ) {
          pending.reject(new DocumentConflictError(
            (remoteError.details as { current: DocumentSnapshot }).current
          ));
        } else {
          pending.reject(new AdapterError(
            remoteError.message,
            remoteError.code || "EXTENSION_ERROR",
            remoteError.details
          ));
        }
      } else {
        pending.resolve(record.result);
      }
      return;
    }

    if (record.type === "event") {
      this.acceptEvent(connection, record);
      return;
    }
    throw new TypeError("Unknown bridge message");
  }

  private completeHandshake(
    connection: ConnectionState,
    message: Record<string, unknown>
  ): void {
    if (
      message.protocolVersion !== PROTOCOL_VERSION ||
      typeof message.token !== "string" ||
      !tokensEqual(message.token, this.authToken!) ||
      !Array.isArray(message.workspaces)
    ) {
      throw new TypeError("Bridge handshake rejected");
    }

    for (const candidate of message.workspaces) {
      if (!candidate || typeof candidate !== "object") {
        throw new TypeError("Invalid workspace handshake");
      }
      const item = candidate as { id?: unknown; rootPath?: unknown };
      if (typeof item.id !== "string" || typeof item.rootPath !== "string") {
        throw new TypeError("Invalid workspace handshake");
      }
      const workspace = this.workspaces.get(item.id);
      if (!workspace || workspace.rootPath !== item.rootPath) {
        continue;
      }
      const existing = this.findConnection(item.id);
      if (existing && existing !== connection) {
        throw new TypeError(`Workspace '${item.id}' is already connected`);
      }
      connection.workspaceIds.add(item.id);
    }

    connection.ready = true;
    clearTimeout(connection.handshakeTimer);
    connection.socket.write(`${JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      workspaces: Array.from(connection.workspaceIds)
    })}\n`);
    bridgeDebug(`handshake accepted for ${Array.from(connection.workspaceIds).join(",")}`);

    for (const workspaceId of connection.workspaceIds) {
      const waiters = this.connectionWaiters.get(workspaceId);
      if (waiters) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.connectionWaiters.delete(workspaceId);
      }
    }
  }

  private acceptEvent(
    connection: ConnectionState,
    message: Record<string, unknown>
  ): void {
    const type = message.eventType as AdapterEventType;
    if (
      typeof message.workspaceId !== "string" ||
      !connection.workspaceIds.has(message.workspaceId) ||
      !["document.opened", "document.changed", "document.saved", "document.closed"].includes(type) ||
      typeof message.path !== "string" ||
      !Number.isSafeInteger(message.version) ||
      typeof message.dirty !== "boolean" ||
      !(message.origin === null || isAgentIdentity(message.origin))
    ) {
      throw new TypeError("Invalid bridge event");
    }

    const event: AdapterEvent = {
      id: ++this.nextEventId,
      type,
      workspaceId: message.workspaceId,
      path: normalizeDocumentPath(message.path),
      version: message.version as number,
      dirty: message.dirty,
      timestamp: new Date().toISOString(),
      origin: message.origin
    };
    this.events.push(event);
    if (this.events.length > this.eventBufferSize) {
      this.events.splice(0, this.events.length - this.eventBufferSize);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }
}
