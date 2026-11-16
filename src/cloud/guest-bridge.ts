import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { encodeFrame, FrameDecoder, parseFrame } from "../bus/protocol.js";
import { errorFromPayload } from "../bus/errors.js";
import {
  BUS_PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  BusError,
  type AdapterDocumentListParams,
  type AdapterDocumentListResult,
  type AdapterDocumentReadParams,
  type AdapterDocumentReadResult,
  type AdapterDocumentWriteParams,
  type AdapterDocumentWriteResult,
  type AdapterWorkspaceListParams,
  type AdapterWorkspaceListResult,
  type AgentIdentity,
  type BusCapability,
  type BusErrorPayload,
  type BusEvent,
  type BusMethod,
  type BusParams,
  type BusResult,
  type EventSubscribeParams,
  type EventSubscription,
  type WorkspaceListParams,
  type WorkspaceListResult,
  type WorkspaceReadParams,
  type WorkspaceReadResult,
  type WorkspaceWriteParams,
  type WorkspaceWriteResult
} from "../bus/index.js";

/**
 * Reaches a guest's agent bus through the worker.
 *
 * Two transports exist, because a restricted Incus project may forbid proxy
 * devices (which is exactly what this worker does):
 *
 *   "proxy"  — the socket is bound on the worker's filesystem by an Incus proxy
 *              device, and `ssh -W <path>` tunnels it. Cheapest, and the only
 *              one that keeps the bus unreachable from a guest shell.
 *   "exec"   — no device is involved: ssh runs `nc -U <socket>` inside the
 *              container and frames are piped over that. Works wherever the
 *              guest has a Unix-socket-capable netcat.
 *
 * The bytes on the wire are identical either way; only how they leave the guest
 * differs. The `exec` transport carries the same authenticated handshake, so an
 * agent without a valid grant is refused in both cases.
 */

export const GUEST_SOCKET_DIRECTORY = "/run/syntrum/guests";
const GUEST_BUS_SOCKET = "/run/syntrum/bus.sock";

export type GuestTransport = "proxy" | "exec";

export function guestTransport(): GuestTransport {
  return process.env.SYNTRUM_GUEST_TRANSPORT === "exec" ? "exec" : "proxy";
}


// Overridable so the bridge can be exercised without writing under /run, which
// is read-only on a development Mac. The value is process-wide and never comes
// from a request.
function socketDirectory(): string {
  return process.env.SYNTRUM_GUEST_SOCKET_DIR ?? GUEST_SOCKET_DIRECTORY;
}
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type GuestBridgeSsh = {
  host: string;
  user: string;
  knownHostsPath?: string;
  identityFile?: string;
};

export type AgentCredentials = {
  agentId: string;
  token: string;
};

/** The socket path a computer's bus is exposed on, on the worker. */
export function guestSocketPath(computerId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(computerId)) {
    throw new TypeError(`Invalid computer id for a guest socket path: ${computerId}`);
  }
  return `${socketDirectory()}/${computerId}.sock`;
}

export function sshArgs(options: GuestBridgeSsh, socketPath: string, transport: GuestTransport): string[] {
  return [
    // No -n here: it redirects stdin from /dev/null, and this tunnel carries
    // the bus protocol on stdin. The one-shot desktop/command runners can use
    // it because nothing is piped into them.
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    ...(transport === "proxy" ? ["-o", "ExitOnForwardFailure=yes"] : []),
    ...(options.knownHostsPath
      ? ["-o", `UserKnownHostsFile=${options.knownHostsPath}`]
      : []),
    ...(options.identityFile
      ? ["-i", options.identityFile, "-o", "IdentitiesOnly=yes"]
      : []),
    `${options.user}@${options.host}`,
    "--",
    ...(transport === "proxy"
      // -W with a path connects to a Unix socket on the remote host.
      ? ["-W", socketPath]
      // No device on this worker: bridge to the socket from inside the guest.
      // Node does the copying rather than netcat: this image's OpenBSD nc
      // refuses `-U` with a port and buffers stdin, and Node is already present
      // because it runs the daemon itself.
      // A shipped script, not an inline `-e` string: the remote shell strips
      // quotes from a multi-statement one-liner.
      : ["incus", "exec", computerIdFromSocket(socketPath), "--",
         "/usr/local/bin/node", "/opt/syntrum/guest/relay.js"])
  ];
}

/**
 * The exec transport needs the container name, which the socket path already
 * encodes. Kept as a derivation rather than a second argument so the two can
 * never disagree about which computer is being reached.
 */
function computerIdFromSocket(socketPath: string): string {
  const base = socketPath.slice(socketPath.lastIndexOf("/") + 1);
  const id = base.endsWith(".sock") ? base.slice(0, -".sock".length) : base;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new TypeError(`Cannot derive a computer id from ${socketPath}`);
  }
  return id;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: BusError) => void;
  timer: NodeJS.Timeout;
};

/**
 * A bus client whose transport is an ssh child process rather than a local
 * socket. Mirrors the handshake and request shapes of `BusClient` exactly, so
 * the agent side of the protocol is identical whether the guest is local or
 * across the network.
 */
export class GuestBusClient {
  readonly computerId: string;
  readonly agentId: string;
  capabilities: readonly BusCapability[] = [];
  sessionIds: readonly string[] = [];

  private readonly child: ReturnType<typeof spawn>;
  private readonly token: string;
  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: BusEvent) => void>();
  private connected = false;
  private closing = false;
  private exitReason?: string;

  private constructor(
    computerId: string,
    agent: AgentIdentity & { token: string },
    child: ReturnType<typeof spawn>
  ) {
    this.computerId = computerId;
    this.agentId = agent.id;
    this.token = agent.token;
    this.child = child;
    this.decoder = new FrameDecoder(DEFAULT_MAX_FRAME_BYTES);
  }

  /** Opens the tunnel and completes the bus handshake with the agent's grant. */
  static async connect(options: {
    computerId: string;
    agent: AgentIdentity & { token: string };
    ssh: GuestBridgeSsh;
    requestTimeoutMs?: number;
    transport?: GuestTransport;
  }): Promise<GuestBusClient> {
    const socketPath = guestSocketPath(options.computerId);
    const transport = options.transport ?? guestTransport();
    const child = spawn("ssh", sshArgs(options.ssh, socketPath, transport), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new GuestBusClient(options.computerId, options.agent, child);

    await client.open(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    return client;
  }

  get isConnected(): boolean {
    return this.connected && !this.closing;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.connected = false;
    this.rejectPending(new BusError("CLIENT_CLOSED", "Guest bus client was closed"));
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    // A tunnel that does not exit on its own must not leak a process.
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    timer.unref();
  }

  onEvent(listener: (event: BusEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  listWorkspaces(params: AdapterWorkspaceListParams): Promise<AdapterWorkspaceListResult> {
    return this.request("adapter.workspace.list", params);
  }

  listDocuments(params: AdapterDocumentListParams): Promise<AdapterDocumentListResult> {
    return this.request("adapter.document.list", params);
  }

  readDocument(params: AdapterDocumentReadParams): Promise<AdapterDocumentReadResult> {
    return this.request("adapter.document.read", params);
  }

  writeDocument(params: AdapterDocumentWriteParams): Promise<AdapterDocumentWriteResult> {
    return this.request("adapter.document.write", params);
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

  subscribe(params: EventSubscribeParams): Promise<EventSubscription> {
    return this.request("event.subscribe", params);
  }

  unsubscribe(subscriptionId: string): Promise<{ subscriptionId: string; removed: boolean }> {
    return this.request("event.unsubscribe", { subscriptionId });
  }

  publish(params: {
    sessionId: string;
    channel: string;
    data: unknown;
  }): Promise<{ event: BusEvent }> {
    return this.request("event.publish", params);
  }

  ping(): Promise<{ now: string }> {
    return this.request("ping", {});
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolveOpen, rejectOpen) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.child.kill("SIGKILL");
        rejectOpen(new BusError("CONNECT_TIMEOUT", "Guest bus connection timed out"));
      }, CONNECT_TIMEOUT_MS);

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectOpen(error instanceof BusError
          ? error
          : new BusError("CONNECTION_FAILED", "Guest bus connection failed"));
      };

      this.child.on("error", error => fail(
        new BusError("TUNNEL_FAILED", `Could not start the SSH tunnel: ${error.message}`)
      ));
      this.child.stderr?.on("data", (chunk: Buffer) => {
        // ssh diagnostics are the operator's, not the agent's. Keep the last
        // line so a failed tunnel can say why instead of hanging.
        const text = chunk.toString("utf8").trim();
        if (text) this.exitReason = text.split("\n").at(-1);
      });
      this.child.on("exit", () => {
        this.connected = false;
        const reason = this.exitReason;
        const error = new BusError(
          "CONNECTION_CLOSED",
          reason ? `Guest bus tunnel closed: ${reason}` : "Guest bus tunnel closed"
        );
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectOpen(error);
        }
        this.rejectPending(error);
      });

      this.child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.decoder.push(chunk, frame => this.receive(frame, () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolveOpen();
            }
          }));
        } catch (error) {
          const busError = error instanceof BusError
            ? error
            : new BusError("PROTOCOL_ERROR", "Invalid frame from the guest bus");
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            rejectOpen(busError);
          }
          this.child.kill("SIGKILL");
        }
      });

      try {
        this.child.stdin?.write(encodeFrame({
          version: BUS_PROTOCOL_VERSION,
          type: "hello",
          agent: { id: this.agentId, token: this.token },
          maxFrameBytes: DEFAULT_MAX_FRAME_BYTES
        }, DEFAULT_MAX_FRAME_BYTES));
      } catch (error) {
        fail(error);
      }
      void timeoutMs;
    });
  }

  private receive(frame: Buffer, onWelcome: () => void): void {
    const message = parseFrame(frame);
    if (message.version !== BUS_PROTOCOL_VERSION) {
      throw new BusError(
        "VERSION_MISMATCH",
        `Protocol version must be ${BUS_PROTOCOL_VERSION}`
      );
    }

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
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) {
        pending.resolve(message.result);
      } else {
        pending.reject(errorFromPayload(message.error as BusErrorPayload));
      }
      return;
    }

    if (message.type === "event") {
      const event = message.event as BusEvent;
      for (const listener of this.eventListeners) {
        listener(event);
      }
      return;
    }

    throw new BusError("INVALID_RESPONSE", "Unexpected message from the guest bus");
  }

  private request<M extends BusMethod>(
    method: M,
    params: BusParams<M>
  ): Promise<BusResult<M>> {
    if (!this.isConnected) {
      return Promise.reject(new BusError("NOT_CONNECTED", "Guest bus client is not connected"));
    }
    const id = randomUUID();
    let frame: Buffer;
    try {
      frame = encodeFrame({ version: BUS_PROTOCOL_VERSION, type: "request", id, method, params },
        DEFAULT_MAX_FRAME_BYTES);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<BusResult<M>>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new BusError(
          "REQUEST_TIMEOUT",
          `Request ${method} timed out`
        ));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: value => resolveRequest(value as BusResult<M>),
        reject: rejectRequest,
        timer
      });
      this.child.stdin?.write(frame);
    });
  }

  private rejectPending(error: BusError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
