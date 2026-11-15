import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { EventPage } from "../adapters/types.js";
import { BusError, errorFromPayload } from "./errors.js";
import {
  assertProtocolVersion,
  encodeFrame,
  FrameDecoder,
  parseFrame
} from "./protocol.js";
import {
  BUS_PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  type AdapterDocumentListParams,
  type AdapterDocumentListResult,
  type AdapterDocumentReadParams,
  type AdapterDocumentReadResult,
  type AdapterDocumentWriteParams,
  type AdapterDocumentWriteResult,
  type AdapterEventsReadParams,
  type AdapterWorkspaceListParams,
  type AdapterWorkspaceListResult,
  type AgentIdentity,
  type BusCapability,
  type BusErrorPayload,
  type BusEvent,
  type BusMethod,
  type BusParams,
  type BusResult,
  type EventPublishParams,
  type EventSubscribeParams,
  type EventSubscription,
  type WorkspaceListParams,
  type WorkspaceListResult,
  type WorkspaceReadParams,
  type WorkspaceReadResult,
  type WorkspaceWriteParams,
  type WorkspaceWriteResult
} from "./types.js";

export type BusClientOptions = {
  socketPath: string;
  agent: AgentIdentity;
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: BusError) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

export class BusClient {
  readonly socketPath: string;
  readonly agent: AgentIdentity;
  readonly maxFrameBytes: number;
  readonly requestTimeoutMs: number;

  agentId?: string;
  capabilities: readonly BusCapability[] = [];
  sessionIds: readonly string[] = [];

  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: BusEvent) => void>();
  private socket?: Socket;
  private connected = false;
  private closing = false;

  private constructor(options: BusClientOptions) {
    this.socketPath = options.socketPath;
    this.agent = options.agent;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 256) {
      throw new TypeError("maxFrameBytes must be a safe integer of at least 256");
    }
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1
    ) {
      throw new TypeError("requestTimeoutMs must be a positive safe integer");
    }
    this.decoder = new FrameDecoder(this.maxFrameBytes);
  }

  static async connect(options: BusClientOptions): Promise<BusClient> {
    const client = new BusClient(options);
    await client.open();
    return client;
  }

  get isConnected(): boolean {
    return this.connected && !this.closing;
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.connected = false;
    this.rejectPending(new BusError("CLIENT_CLOSED", "Bus client was closed"));

    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      return;
    }

    await new Promise<void>(resolveClose => {
      socket.once("close", resolveClose);
      socket.end();
      socket.destroySoon();
    });
  }

  async request<M extends BusMethod>(
    method: M,
    params: BusParams<M>
  ): Promise<BusResult<M>> {
    if (!this.isConnected || this.socket === undefined) {
      throw new BusError("NOT_CONNECTED", "Bus client is not connected");
    }

    const id = randomUUID();
    const frame = encodeFrame({
      version: BUS_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params
    }, this.maxFrameBytes);

    return new Promise<BusResult<M>>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new BusError(
          "REQUEST_TIMEOUT",
          `Request ${method} timed out after ${this.requestTimeoutMs}ms`
        ));
      }, this.requestTimeoutMs);
      timer.unref();

      this.pending.set(id, {
        resolve: result => resolveRequest(result as BusResult<M>),
        reject: rejectRequest,
        timer
      });
      this.socket?.write(frame);
    });
  }

  ping(): Promise<{ now: string }> {
    return this.request("ping", {});
  }

  readFile(params: WorkspaceReadParams): Promise<WorkspaceReadResult> {
    return this.request("workspace.read", params);
  }

  writeFile(params: WorkspaceWriteParams): Promise<WorkspaceWriteResult> {
    return this.request("workspace.write", params);
  }

  listFiles(params: WorkspaceListParams): Promise<WorkspaceListResult> {
    return this.request("workspace.list", params);
  }

  listWorkspaces(
    params: AdapterWorkspaceListParams
  ): Promise<AdapterWorkspaceListResult> {
    return this.request("adapter.workspace.list", params);
  }

  listDocuments(
    params: AdapterDocumentListParams
  ): Promise<AdapterDocumentListResult> {
    return this.request("adapter.document.list", params);
  }

  readDocument(
    params: AdapterDocumentReadParams
  ): Promise<AdapterDocumentReadResult> {
    return this.request("adapter.document.read", params);
  }

  writeDocument(
    params: AdapterDocumentWriteParams
  ): Promise<AdapterDocumentWriteResult> {
    return this.request("adapter.document.write", params);
  }

  getEvents(params: AdapterEventsReadParams): Promise<EventPage> {
    return this.request("adapter.events.read", params);
  }

  publish(params: EventPublishParams): Promise<{ event: BusEvent }> {
    return this.request("event.publish", params);
  }

  subscribe(params: EventSubscribeParams): Promise<EventSubscription> {
    return this.request("event.subscribe", params);
  }

  unsubscribe(subscriptionId: string): Promise<{
    subscriptionId: string;
    removed: boolean;
  }> {
    return this.request("event.unsubscribe", { subscriptionId });
  }

  onEvent(listener: (event: BusEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private open(): Promise<void> {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      let opened = false;

      socket.on("data", chunk => {
        try {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          this.decoder.push(bytes, frame => this.receiveFrame(frame, () => {
            if (!opened) {
              opened = true;
              resolveOpen();
            }
          }));
        } catch (error) {
          const busError = error instanceof BusError
            ? error
            : new BusError("PROTOCOL_ERROR", "Invalid server response");
          if (!opened) {
            opened = true;
            rejectOpen(busError);
          }
          this.terminate(busError);
        }
      });
      socket.on("error", error => {
        const busError = new BusError("SOCKET_ERROR", error.message);
        if (!opened) {
          opened = true;
          rejectOpen(busError);
        }
        this.rejectPending(busError);
      });
      socket.on("close", () => {
        this.connected = false;
        const error = new BusError("CONNECTION_CLOSED", "Bus connection closed");
        if (!opened) {
          opened = true;
          rejectOpen(error);
        }
        this.rejectPending(error);
      });

      socket.once("connect", () => {
        try {
          socket.write(encodeFrame({
            version: BUS_PROTOCOL_VERSION,
            type: "hello",
            agent: this.agent,
            maxFrameBytes: this.maxFrameBytes
          }, this.maxFrameBytes));
        } catch (error) {
          opened = true;
          rejectOpen(error);
          this.terminate(error);
        }
      });
    });
  }

  private receiveFrame(frame: Buffer, onWelcome: () => void): void {
    const message = parseFrame(frame);
    assertProtocolVersion(message);

    if (!this.connected) {
      if (message.type === "error") {
        throw errorFromPayload(message.error as BusErrorPayload);
      }
      if (
        message.type !== "welcome" ||
        typeof message.agentId !== "string" ||
        !Array.isArray(message.capabilities) ||
        !Array.isArray(message.sessionIds)
      ) {
        throw new BusError("HANDSHAKE_FAILED", "Expected a welcome message");
      }

      this.connected = true;
      this.agentId = message.agentId;
      this.capabilities = message.capabilities as BusCapability[];
      this.sessionIds = message.sessionIds as string[];
      onWelcome();
      return;
    }

    if (message.type === "response") {
      if (typeof message.id !== "string") {
        throw new BusError("INVALID_RESPONSE", "Response ID is missing");
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.ok === true) {
        pending.resolve(message.result);
      } else if (message.ok === false) {
        pending.reject(errorFromPayload(message.error as BusErrorPayload));
      } else {
        throw new BusError("INVALID_RESPONSE", "Response status is invalid");
      }
      return;
    }

    if (message.type === "event") {
      const event = message.event as BusEvent;
      if (
        typeof event !== "object" ||
        event === null ||
        typeof event.id !== "string" ||
        typeof event.sessionId !== "string" ||
        typeof event.channel !== "string" ||
        typeof event.publisherId !== "string" ||
        typeof event.publishedAt !== "string" ||
        !this.sessionIds.includes(event.sessionId)
      ) {
        throw new BusError("INVALID_EVENT", "Server sent an invalid event");
      }
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {
          // Application listeners cannot interrupt protocol processing.
        }
      }
      return;
    }

    throw new BusError("INVALID_MESSAGE", "Unexpected server message");
  }

  private terminate(error: unknown): void {
    this.closing = true;
    this.connected = false;
    this.rejectPending(error instanceof BusError
      ? error
      : new BusError("PROTOCOL_ERROR", "Bus protocol error"));
    this.socket?.destroy();
  }

  private rejectPending(error: BusError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
