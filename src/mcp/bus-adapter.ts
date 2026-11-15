import { BusClient, BusError } from "../bus/index.js";
import {
  AdapterError,
  DocumentConflictError
} from "../adapters/errors.js";
import {
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
} from "../adapters/types.js";

export type BusApplicationAdapterOptions = {
  application?: string;
};

function isDocumentSnapshot(value: unknown): value is DocumentSnapshot {
  if (typeof value !== "object" || value === null) {
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

export class BusApplicationAdapter implements ApplicationAdapter {
  readonly application: string;

  constructor(
    readonly client: BusClient,
    options: BusApplicationAdapterOptions = {}
  ) {
    this.application = options.application ?? "vscode";
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    await this.client.close();
  }

  async listWorkspaces(agent: AgentIdentity): Promise<WorkspaceInfo[]> {
    this.assertIdentity(agent);
    const result = await this.request(() => this.client.listWorkspaces({
      sessionId: agent.sessionId
    }));
    return result.workspaces;
  }

  async listDocuments(
    agent: AgentIdentity,
    workspaceId: string
  ): Promise<DocumentDescriptor[]> {
    this.assertIdentity(agent);
    const result = await this.request(() => this.client.listDocuments({
      sessionId: agent.sessionId,
      workspaceId
    }));
    return result.documents;
  }

  async readDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string
  ): Promise<DocumentSnapshot> {
    this.assertIdentity(agent);
    const result = await this.request(() => this.client.readDocument({
      sessionId: agent.sessionId,
      workspaceId,
      path
    }));
    return result.document;
  }

  async writeDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot> {
    this.assertIdentity(agent);
    const result = await this.request(() => this.client.writeDocument({
      sessionId: agent.sessionId,
      workspaceId,
      path,
      text,
      expectedVersion: options.expectedVersion
    }));
    return result.document;
  }

  async getEvents(
    agent: AgentIdentity,
    options: ReadEventsOptions = {}
  ): Promise<EventPage> {
    this.assertIdentity(agent);
    return this.request(() => this.client.getEvents({
      sessionId: agent.sessionId,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.limit === undefined ? {} : { limit: options.limit })
    }));
  }

  onEvent(_listener: (event: AdapterEvent) => void): () => void {
    return () => undefined;
  }

  private assertIdentity(agent: AgentIdentity): void {
    assertAgentIdentity(agent);
    if (agent.agentId !== this.client.agentId) {
      throw new AdapterError(
        "Agent identity does not match the bus connection",
        "AGENT_IDENTITY_MISMATCH"
      );
    }
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AdapterError) {
        throw error;
      }
      if (error instanceof BusError) {
        const current = error.details?.current;
        if (error.code === "VERSION_CONFLICT" && isDocumentSnapshot(current)) {
          throw new DocumentConflictError(current);
        }
        throw new AdapterError(error.message, error.code, error.details);
      }
      throw error;
    }
  }
}
