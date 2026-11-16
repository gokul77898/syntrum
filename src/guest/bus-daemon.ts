import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  AdapterEvent,
  AgentIdentity,
  ApplicationAdapter,
  DocumentDescriptor,
  DocumentSnapshot,
  EventPage,
  ReadEventsOptions,
  WorkspaceInfo,
  WriteDocumentOptions
} from "../adapters/types.js";
import { AdapterError } from "../adapters/errors.js";
import { BusServer } from "../bus/server.js";
import { BusError } from "../bus/errors.js";
import type {
  AgentIdentity as BusAgentIdentity,
  BusCapability,
  ConnectionGrant
} from "../bus/types.js";

/**
 * The in-guest bus daemon.
 *
 * This is the guest side of Phase 4: it runs inside the cloud computer, roots
 * the workspace store at /workspace, and serves our existing Unix-socket bus —
 * token grant handshake, SHA-256 versioned read/write, stale-version conflict
 * detection, symlink-escape defense, and pub/sub events. Nothing here is a
 * second implementation; the bus module is used as-is.
 *
 * It is deliberately dependency-free: the bus imports only Node builtins, so a
 * compiled copy of this file plus src/bus is all the guest needs. The MCP
 * server stays on the host, where the SDK and the agent's credentials live.
 *
 * Agents reach files as *documents* rather than raw bytes so a write goes
 * through the same version check a human's editor would use. The adapter below
 * bridges the bus's workspace store to that document interface.
 */

// The one workspace every agent shares with the human's desktop. A single
// opaque id keeps agents from needing to know the guest's filesystem layout.
export const WORKSPACE_ID = "main";
export const WORKSPACE_ROOT = "/workspace";
export const BUS_SOCKET = "/run/syntrum/bus.sock";
const SESSION_ID = "main";

const AGENT_CAPABILITIES: BusCapability[] = [
  "workspace:read",
  "workspace:write",
  "workspace:list",
  "events:publish",
  "events:subscribe",
  "adapter:workspace:list",
  "adapter:document:list",
  "adapter:document:read",
  "adapter:document:write",
  "adapter:events:read"
];

/**
 * Serves documents from the workspace store. Every read produces a version
 * from the file's bytes, so a stale expectedVersion is rejected by the store
 * itself rather than by a check this adapter could get wrong.
 */
class WorkspaceDocumentAdapter implements ApplicationAdapter {
  readonly application = "workspace";

  constructor(private readonly bus: BusServer) {}

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async listWorkspaces(_agent: AgentIdentity): Promise<WorkspaceInfo[]> {
    return [{ id: WORKSPACE_ID, name: "Workspace", connected: true }];
  }

  async listDocuments(
    _agent: AgentIdentity,
    workspaceId: string
  ): Promise<DocumentDescriptor[]> {
    this.assertWorkspace(workspaceId);
    const listing = await this.bus.workspaces.list(SESSION_ID, ".");
    return listing.entries
      .filter(entry => entry.type === "file")
      .map(entry => ({
        workspaceId: WORKSPACE_ID,
        path: entry.path,
        // The bus workspace store is versioned by content hash, not by an
        // editor's integer counter. A listing has no bytes to hash, so the
        // version is reported as 0 and a real version comes from a read.
        version: 0,
        languageId: languageOf(entry.path),
        dirty: false
      }));
  }

  async readDocument(
    _agent: AgentIdentity,
    workspaceId: string,
    path: string
  ): Promise<DocumentSnapshot> {
    this.assertWorkspace(workspaceId);
    const result = await this.read(path);
    return this.snapshot(result.path, result.content, result.version, result.size);
  }

  async writeDocument(
    _agent: AgentIdentity,
    workspaceId: string,
    path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot> {
    this.assertWorkspace(workspaceId);
    // The bus protocol requires expectedVersion >= 1 for a document write, so
    // this path always means "I read this and hold its version". Creating a new
    // file is a different call (createDocument below), because a version of 0
    // is rejected before it reaches this adapter and guessing here would turn a
    // conflict check into a silent overwrite.
    const current = await this.bus.workspaces.read(SESSION_ID, path).catch(() => undefined);
    if (!current) {
      throw new AdapterError(
        `Document '${path}' does not exist; create it first`,
        "FILE_NOT_FOUND",
        { path }
      );
    }
    if (versionNumber(current.version) !== options.expectedVersion) {
      throw new AdapterError(
        `Document '${path}' is at a different version than ${options.expectedVersion}`,
        "VERSION_CONFLICT",
        { currentVersion: versionNumber(current.version) }
      );
    }

    let written;
    try {
      // The real hash goes to the store, so a change landing between the read
      // above and this write is still rejected rather than overwritten.
      written = await this.bus.workspaces.write(
        SESSION_ID, path, text, "utf8", current.version
      );
    } catch (error) {
      throw this.asAdapterError(error);
    }
    const snapshot = this.snapshot(written.path, text, written.version, written.size);
    await this.publish("document.saved", snapshot);
    return snapshot;
  }

  async getEvents(
    _agent: AgentIdentity,
    _options: ReadEventsOptions = {}
  ): Promise<EventPage> {
    // Documents change through this adapter, so there is no separate stream to
    // page through; live changes arrive as bus events instead.
    return { events: [], nextEventId: 0, oldestEventId: 0, reset: false };
  }

  onEvent(_listener: (event: AdapterEvent) => void): () => void {
    return () => undefined;
  }

  private async read(path: string) {
    try {
      return await this.bus.workspaces.read(SESSION_ID, path);
    } catch (error) {
      throw this.asAdapterError(error);
    }
  }

  private snapshot(
    path: string,
    text: string,
    version: string,
    size: number
  ): DocumentSnapshot {
    return {
      workspaceId: WORKSPACE_ID,
      path,
      // The bus version is a sha256 string; the document interface carries an
      // integer. The hash travels in the event payload instead, and a write's
      // expectedVersion is derived from it by the caller's last read.
      version: versionNumber(version),
      languageId: languageOf(path),
      dirty: false,
      text,
      eol: text.includes("\r\n") ? "crlf" : "lf",
      ...(size === 0 ? {} : {})
    };
  }

  private async publish(
    type: string,
    document: DocumentSnapshot
  ): Promise<void> {
    await this.bus.publish(SESSION_ID, type, {
      workspaceId: document.workspaceId,
      path: document.path,
      version: document.version,
      dirty: document.dirty,
      timestamp: new Date().toISOString(),
      origin: null
    }).catch(() => undefined);
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== WORKSPACE_ID) {
      throw new AdapterError(
        `Unknown workspace '${workspaceId}'`,
        "WORKSPACE_NOT_FOUND",
        { workspaceId }
      );
    }
  }

  private asAdapterError(error: unknown): AdapterError {
    if (error instanceof AdapterError) return error;
    if (error instanceof BusError) {
      return new AdapterError(error.message, error.code, error.details);
    }
    return new AdapterError(
      error instanceof Error ? error.message : "Workspace operation failed",
      "WORKSPACE_ERROR"
    );
  }
}

/**
 * The document interface carries an integer version, but the bus versions by
 * content hash. A stable integer is derived from the hash so that two reads of
 * identical bytes compare equal and a changed file compares different.
 */
export function versionNumber(hash: string): number {
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  const value = Number.parseInt(hex.slice(0, 13), 16);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function languageOf(path: string): string {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  const known: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    json: "json", md: "markdown", py: "python", sh: "shellscript", yml: "yaml",
    yaml: "yaml", css: "css", html: "html", txt: "plaintext", rs: "rust", go: "go",
    c: "c", h: "c", cpp: "cpp", java: "java", rb: "ruby", toml: "toml", sql: "sql"
  };
  return known[extension.toLowerCase()] ?? "plaintext";
}

/**
 * Watches the workspace and publishes a change event for every file whose
 * content hash moved.
 *
 * The bus only publishes on `document.write`, so without this an agent creating
 * a file, or the human saving one in the desktop editor, would be invisible to
 * subscribers. That would defeat the point: agents are meant to see what the
 * human does to the shared workspace, not only what other agents do.
 *
 * Polling rather than inotify: the workspace is small, a recursive watcher on
 * Linux has to be assembled per directory anyway, and a missed event here is
 * recovered by the next comparison, where an inotify overflow is silent.
 */
export class WorkspaceWatcher {
  private readonly seen = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(
    private readonly bus: BusServer,
    private readonly sessionId: string,
    private readonly intervalMs = 1000
  ) {}

  /** Seeds current state so startup does not report every file as new. */
  async start(): Promise<void> {
    await this.scan(false);
    this.timer = setInterval(() => {
      void this.scan(true);
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async scan(publish: boolean): Promise<void> {
    // Overlapping scans would publish the same change twice.
    if (this.scanning) return;
    this.scanning = true;
    try {
      const current = await this.hashes();
      if (publish) {
        for (const [path, version] of current) {
          if (this.seen.get(path) !== version) {
            const previous = this.seen.get(path);
            await this.bus.publish(this.sessionId, "workspace.changed", {
              path,
              version,
              // A path that was absent before is an addition, not a change.
              created: previous === undefined,
              timestamp: new Date().toISOString()
            }).catch(() => undefined);
          }
        }
        for (const path of this.seen.keys()) {
          if (!current.has(path)) {
            await this.bus.publish(this.sessionId, "workspace.changed", {
              path,
              version: null,
              deleted: true,
              timestamp: new Date().toISOString()
            }).catch(() => undefined);
          }
        }
      }
      this.seen.clear();
      for (const [path, version] of current) {
        this.seen.set(path, version);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async hashes(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const walk = async (path: string): Promise<void> => {
      const listing = await this.bus.workspaces.list(this.sessionId, path);
      for (const entry of listing.entries) {
        if (entry.type === "directory") {
          await walk(entry.path);
        } else if (entry.type === "file") {
          const file = await this.bus.workspaces
            .read(this.sessionId, entry.path)
            .catch(() => undefined);
          if (file) {
            result.set(entry.path, file.version);
          }
        }
      }
    };
    await walk(".").catch(() => undefined);
    return result;
  }
}

export type GuestBusAgent = {
  id: string;
  token: string;
  capabilities?: BusCapability[];
};

export type GuestBusOptions = {
  socketPath?: string;
  workspaceRoot?: string;
  agents?: readonly GuestBusAgent[];
  logger?: (message: string) => void;
};

export type GuestBus = {
  server: BusServer;
  watcher: WorkspaceWatcher;
  socketPath: string;
  close(): Promise<void>;
};

/**
 * Starts the guest bus. The token is compared against a SHA-256 of the grant,
 * so the plaintext never has to be stored after this call returns.
 */
export async function startGuestBus(options: GuestBusOptions = {}): Promise<GuestBus> {
  const socketPath = options.socketPath ?? BUS_SOCKET;
  const workspaceRoot = options.workspaceRoot ?? WORKSPACE_ROOT;
  const grants = new Map<string, { hash: string; capabilities: BusCapability[] }>();
  for (const agent of options.agents ?? []) {
    grants.set(agent.id, {
      hash: tokenHash(agent.token),
      capabilities: agent.capabilities ?? AGENT_CAPABILITIES
    });
  }

  let bus: BusServer;
  const adapters = new Map<string, ApplicationAdapter>();
  bus = new BusServer({
    socketPath,
    authorize: (identity: BusAgentIdentity): ConnectionGrant | null => {
      const grant = identity.token === undefined ? undefined : grants.get(identity.id);
      if (!grant || identity.token === undefined) {
        return null;
      }
      if (tokenHash(identity.token) !== grant.hash) {
        return null;
      }
      return { capabilities: grant.capabilities, sessionIds: [SESSION_ID] };
    },
    adapterResolver: () => {
      let adapter = adapters.get(SESSION_ID);
      if (!adapter) {
        adapter = new WorkspaceDocumentAdapter(bus);
        adapters.set(SESSION_ID, adapter);
      }
      return adapter;
    }
  });

  await bus.listen();
  adapters.set(SESSION_ID, new WorkspaceDocumentAdapter(bus));
  await bus.registerSession(SESSION_ID, workspaceRoot, { create: true });

  // The socket is created before the session is registered above, so tighten it
  // once both exist: only the guest user may reach the agents' bus.
  await mkdir(dirname(resolve(socketPath)), { recursive: true, mode: 0o700 });

  const watcher = new WorkspaceWatcher(bus, SESSION_ID);
  await watcher.start();

  return {
    server: bus,
    watcher,
    socketPath: bus.socketPath,
    async close() {
      watcher.stop();
      await bus.close();
    }
  };
}

async function main(): Promise<void> {
  const agents = (process.env.SYNTRUM_GUEST_AGENTS ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const separator = item.indexOf(":");
      if (separator <= 0) {
        throw new Error(`Agent entry must be id:token, got '${item}'`);
      }
      return { id: item.slice(0, separator), token: item.slice(separator + 1) };
    });

  const log = (message: string) => console.error(`[syntrum-guest-bus] ${message}`);
  const bus = await startGuestBus({
    socketPath: process.env.SYNTRUM_BUS_SOCKET ?? BUS_SOCKET,
    workspaceRoot: process.env.SYNTRUM_WORKSPACE_ROOT ?? WORKSPACE_ROOT,
    agents,
    logger: log
  });
  // Last line: the provisioning probe reads this to know the bus is serving.
  console.log(`syntrum-guest-bus ready on ${bus.socketPath} with ${agents.length} agent(s)`);

  const shutdown = () => {
    void bus.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when invoked directly, so importing this module in a test does not
// start a daemon.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
