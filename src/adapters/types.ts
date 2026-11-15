export interface AgentIdentity {
  agentId: string;
  sessionId: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  connected: boolean;
}

export interface DocumentDescriptor {
  workspaceId: string;
  path: string;
  version: number;
  languageId: string;
  dirty: boolean;
}

export interface DocumentSnapshot extends DocumentDescriptor {
  text: string;
  eol: "lf" | "crlf";
}

export interface WriteDocumentOptions {
  expectedVersion: number;
}

export type AdapterEventType =
  | "document.opened"
  | "document.changed"
  | "document.saved"
  | "document.closed";

export interface AdapterEvent {
  id: number;
  type: AdapterEventType;
  workspaceId: string;
  path: string;
  version: number;
  dirty: boolean;
  timestamp: string;
  origin: AgentIdentity | null;
}

export interface ReadEventsOptions {
  after?: number;
  limit?: number;
}

export interface EventPage {
  events: AdapterEvent[];
  nextEventId: number;
  oldestEventId: number;
  reset: boolean;
}

export interface ApplicationAdapter {
  readonly application: string;
  start(): Promise<void>;
  close(): Promise<void>;
  listWorkspaces(agent: AgentIdentity): Promise<WorkspaceInfo[]>;
  listDocuments(
    agent: AgentIdentity,
    workspaceId: string
  ): Promise<DocumentDescriptor[]>;
  readDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string
  ): Promise<DocumentSnapshot>;
  writeDocument(
    agent: AgentIdentity,
    workspaceId: string,
    path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot>;
  getEvents(
    agent: AgentIdentity,
    options?: ReadEventsOptions
  ): Promise<EventPage>;
  onEvent(listener: (event: AdapterEvent) => void): () => void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertAgentIdentity(agent: AgentIdentity): void {
  if (
    !agent ||
    !IDENTIFIER.test(agent.agentId) ||
    !IDENTIFIER.test(agent.sessionId)
  ) {
    throw new TypeError(
      "Agent and session identifiers must be 1-128 characters using letters, numbers, '.', '_', ':', or '-'"
    );
  }
}
