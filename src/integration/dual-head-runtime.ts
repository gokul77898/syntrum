import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  VSCodeAdapter,
  assertAgentIdentity,
  type AdapterEvent,
  type AgentIdentity,
  type ApplicationAdapter,
  type DocumentDescriptor,
  type DocumentSnapshot,
  type EventPage,
  type ReadEventsOptions,
  type WorkspaceInfo,
  type WriteDocumentOptions
} from "../adapters/index.js";
import {
  BusServer,
  type AgentIdentity as BusAgentIdentity,
  type BusCapability,
  type ConnectionGrant
} from "../bus/index.js";
import {
  log,
  RuntimeError,
  RuntimeSupervisor,
  silentLogger,
  type LaunchResult,
  type Logger,
  type NativeManager,
  type Session,
  type SessionResource
} from "../runtime/index.js";

const AGENT_CAPABILITIES: BusCapability[] = [
  "adapter:workspace:list",
  "adapter:document:list",
  "adapter:document:read",
  "adapter:document:write",
  "adapter:events:read",
  "events:subscribe"
];
const DOCUMENT_EVENT_PREFIX = "adapter.document.";

type ManagedAdapter = {
  raw: VSCodeAdapter;
  durable: DurableVSCodeAdapter;
};

export type IdeLaunchProfile = {
  bundleIdentifier: string;
  applicationPath: string;
  label: string;
  profileDirectoryName: string;
};

export const VSCODE_IDE_PROFILE: IdeLaunchProfile = {
  bundleIdentifier: "com.microsoft.VSCode",
  applicationPath: "/Applications/Visual Studio Code.app",
  label: "Visual Studio Code",
  profileDirectoryName: "vscode-profile"
};

export const ANTIGRAVITY_IDE_PROFILE: IdeLaunchProfile = {
  bundleIdentifier: "com.google.antigravity-ide",
  applicationPath: "/Applications/Antigravity IDE.app",
  label: "Antigravity IDE",
  profileDirectoryName: "antigravity-profile"
};

export type DualHeadRuntimeOptions = {
  dataRoot?: string;
  databasePath?: string;
  extensionDevelopmentPath?: string;
  ide?: IdeLaunchProfile;
  nativeManager?: NativeManager;
  logger?: Logger;
  pollIntervalMs?: number;
};

export type AgentCredentials = {
  agentId: string;
  sessionId: string;
  token: string;
  busSocketPath: string;
  workspaceIds: string[];
  capabilities: BusCapability[];
};

export type DualHeadReadiness = {
  sessionId: string;
  workspaceRoot: string;
  adapterStarted: boolean;
  extensionConnected: boolean;
};

class DurableVSCodeAdapter implements ApplicationAdapter {
  readonly application = "vscode";

  constructor(
    private readonly raw: VSCodeAdapter,
    private readonly supervisor: RuntimeSupervisor,
    private readonly bus: BusServer,
    private readonly sessionId: string
  ) {}

  async start(): Promise<void> {
    await this.raw.start();
  }

  async close(): Promise<void> {
    await this.raw.close();
  }

  listWorkspaces(agent: AgentIdentity): Promise<WorkspaceInfo[]> {
    return this.raw.listWorkspaces(agent);
  }

  listDocuments(agent: AgentIdentity, workspaceId: string): Promise<DocumentDescriptor[]> {
    return this.raw.listDocuments(agent, workspaceId);
  }

  readDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string
  ): Promise<DocumentSnapshot> {
    return this.raw.readDocument(agent, workspaceId, path);
  }

  writeDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot> {
    return this.raw.writeDocument(agent, workspaceId, path, text, options);
  }

  async getEvents(agent: AgentIdentity, options: ReadEventsOptions = {}): Promise<EventPage> {
    assertAgentIdentity(agent);
    const after = options.after ?? 0;
    const limit = options.limit ?? 50;
    const events = this.supervisor.listEvents(
      this.sessionId,
      after,
      limit,
      DOCUMENT_EVENT_PREFIX
    ).map(event => this.adapterEvent(event.id, event.type, event.data));
    const oldest = this.supervisor.listEvents(
      this.sessionId,
      0,
      1,
      DOCUMENT_EVENT_PREFIX
    )[0];
    return {
      events,
      nextEventId: events.at(-1)?.id ?? after,
      oldestEventId: oldest?.id ?? 0,
      reset: false
    };
  }

  onEvent(listener: (event: AdapterEvent) => void): () => void {
    return this.raw.onEvent(listener);
  }

  persist(event: AdapterEvent): void {
    const { id: _volatileId, ...data } = event;
    this.supervisor.recordSessionEvent(
      this.sessionId,
      `adapter.${event.type}`,
      data
    );
    void this.bus.publish(
      this.sessionId,
      event.type,
      event,
      event.origin?.agentId ?? "vscode"
    ).catch(() => undefined);
  }

  private adapterEvent(
    id: number,
    storedType: string,
    data: Record<string, unknown>
  ): AdapterEvent {
    return {
      id,
      type: storedType.slice("adapter.".length) as AdapterEvent["type"],
      workspaceId: data.workspaceId as string,
      path: data.path as string,
      version: data.version as number,
      dirty: data.dirty as boolean,
      timestamp: data.timestamp as string,
      origin: data.origin as AgentIdentity | null
    };
  }
}

export class DualHeadRuntime {
  readonly supervisor: RuntimeSupervisor;
  readonly bus: BusServer;
  private readonly dataRoot: string;
  private readonly extensionDevelopmentPath: string;
  private readonly ide: IdeLaunchProfile;
  private readonly logger: Logger;
  private readonly adapters = new Map<string, ManagedAdapter>();
  private started = false;

  constructor(options: DualHeadRuntimeOptions = {}) {
    this.dataRoot = resolve(options.dataRoot ?? resolve(process.cwd(), "data"));
    this.extensionDevelopmentPath = resolve(
      options.extensionDevelopmentPath ??
      resolve(process.cwd(), "adapters/vscode-extension")
    );
    this.ide = options.ide ?? VSCODE_IDE_PROFILE;
    this.logger = options.logger ?? silentLogger;
    this.supervisor = new RuntimeSupervisor({
      databasePath: options.databasePath ?? resolve(this.dataRoot, "runtime.sqlite"),
      nativeManager: options.nativeManager,
      logger: this.logger,
      pollIntervalMs: options.pollIntervalMs
    });
    this.bus = new BusServer({
      socketPath: resolve(this.dataRoot, "runtime-bus.sock"),
      authorize: identity => this.authorize(identity),
      adapterResolver: sessionId => this.adapters.get(sessionId)?.durable
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.supervisor.start();
    try {
      for (const resource of this.supervisor.listSessionResources()) {
        await this.startResource(resource);
      }
      await this.bus.listen();
      this.started = true;
    } catch (error) {
      await Promise.allSettled(Array.from(this.adapters.values(), item => item.raw.close()));
      this.adapters.clear();
      await this.supervisor.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.bus.close();
    await Promise.allSettled(Array.from(this.adapters.values(), item => item.raw.close()));
    this.adapters.clear();
    this.started = false;
    await this.supervisor.close();
  }

  async createSession(): Promise<Session> {
    const session = this.supervisor.createSession();
    try {
      const resource = await this.provisionResource(session.id);
      await this.startResource(resource);
      return session;
    } catch (error) {
      this.supervisor.recordSessionEvent(session.id, "session.provisioning_failed", {
        message: error instanceof Error ? error.message : "Provisioning failed"
      });
      throw error;
    }
  }

  async provisionAgent(sessionId: string, agentId: string): Promise<AgentCredentials> {
    const resource = this.requireResource(sessionId);
    const token = randomBytes(32).toString("base64url");
    this.supervisor.saveAgentGrant({
      agentId,
      sessionId,
      tokenHash: tokenHash(token),
      capabilities: AGENT_CAPABILITIES,
      createdAt: new Date().toISOString()
    });
    return {
      agentId,
      sessionId,
      token,
      busSocketPath: this.bus.socketPath,
      workspaceIds: ["main"],
      capabilities: [...AGENT_CAPABILITIES]
    };
  }

  launchVSCode(sessionId: string): Promise<LaunchResult> {
    return this.launchIDE(sessionId);
  }

  async launchIDE(sessionId: string): Promise<LaunchResult> {
    const resource = this.requireResource(sessionId);
    const profileRoot = resolve(
      this.dataRoot,
      "sessions",
      sessionId,
      this.ide.profileDirectoryName
    );
    const userDataDirectory = resolve(profileRoot, "user-data");
    const extensionsDirectory = resolve(profileRoot, "extensions");
    await Promise.all([
      mkdir(userDataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(extensionsDirectory, { recursive: true, mode: 0o700 })
    ]);

    const result = await this.supervisor.launchApplication(
      sessionId,
      this.ide.bundleIdentifier,
      {
        workspacePath: resource.workspaceRoot,
        arguments: [
          "--user-data-dir", userDataDirectory,
          "--extensions-dir", extensionsDirectory,
          "--extensionDevelopmentPath", this.extensionDevelopmentPath,
          "--new-window", resource.workspaceRoot
        ],
        environment: {
          CLOUD_AI_OS_DEBUG_BRIDGE: process.env.CLOUD_AI_OS_DEBUG_BRIDGE === "1" ? "1" : "0",
          CLOUD_AI_OS_WORKSPACES: JSON.stringify([
            { id: "main", rootPath: resource.workspaceRoot }
          ]),
          CLOUD_AI_OS_VSCODE_SOCKET: resource.adapterSocketPath,
          CLOUD_AI_OS_VSCODE_TOKEN: resource.adapterToken
        },
        activates: false,
        newInstance: true
      }
    );
    if (result.application.processOrigin !== "launched") {
      throw new RuntimeError(
        409,
        "IDE_PROCESS_REUSED",
        `Refusing to use an existing ${this.ide.label} process for an isolated dual-head session`
      );
    }
    await this.adapters.get(sessionId)?.raw.waitForWorkspace("main", 30_000);
    return result;
  }

  async waitForVSCode(sessionId: string, timeoutMs = 30_000): Promise<void> {
    const managed = this.adapters.get(sessionId);
    if (!managed) {
      throw new RuntimeError(503, "ADAPTER_NOT_AVAILABLE", "VS Code adapter is not running");
    }
    await managed.raw.waitForWorkspace("main", timeoutMs);
  }

  readiness(sessionId: string): DualHeadReadiness {
    const resource = this.requireResource(sessionId);
    const managed = this.adapters.get(sessionId);
    return {
      sessionId,
      workspaceRoot: resource.workspaceRoot,
      adapterStarted: managed !== undefined,
      extensionConnected: managed?.raw.isWorkspaceConnected("main") ?? false
    };
  }

  private authorize(identity: BusAgentIdentity): ConnectionGrant | null {
    if (!identity.token) {
      return null;
    }
    const grant = this.supervisor.getAgentGrant(identity.id);
    if (!grant || !this.adapters.has(grant.sessionId)) {
      return null;
    }
    const expected = Buffer.from(grant.tokenHash, "hex");
    const actual = Buffer.from(tokenHash(identity.token), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }
    return {
      capabilities: grant.capabilities as BusCapability[],
      sessionIds: [grant.sessionId]
    };
  }

  private requireResource(sessionId: string): SessionResource {
    const resource = this.supervisor.getSessionResource(sessionId);
    if (!resource) {
      throw new Error("Session has no dual-head workspace");
    }
    return resource;
  }

  private async provisionResource(sessionId: string): Promise<SessionResource> {
    const workspace = resolve(this.dataRoot, "sessions", sessionId, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const workspaceRoot = await realpath(workspace);
    const now = new Date().toISOString();
    const resource: SessionResource = {
      sessionId,
      workspaceRoot,
      adapterSocketPath: resolve(
        "/tmp",
        `syntrum-${sessionId}`,
        "adapter.sock"
      ),
      adapterToken: randomBytes(32).toString("base64url"),
      createdAt: now,
      updatedAt: now
    };
    this.supervisor.saveSessionResource(resource);
    return resource;
  }

  private async startResource(resource: SessionResource): Promise<void> {
    if (this.adapters.has(resource.sessionId)) {
      return;
    }
    await this.bus.registerSession(resource.sessionId, resource.workspaceRoot, {
      create: true
    });
    const raw = new VSCodeAdapter({
      workspaces: [{ id: "main", rootPath: resource.workspaceRoot }],
      socketPath: resource.adapterSocketPath,
      authToken: resource.adapterToken
    });
    const durable = new DurableVSCodeAdapter(raw, this.supervisor, this.bus, resource.sessionId);
    raw.onEvent(event => durable.persist(event));
    try {
      await raw.start();
      this.adapters.set(resource.sessionId, { raw, durable });
    } catch (error) {
      this.bus.unregisterSession(resource.sessionId);
      log(this.logger, "error", "session.adapter_start_failed", "VS Code adapter failed to start", {
        sessionId: resource.sessionId,
        cause: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
