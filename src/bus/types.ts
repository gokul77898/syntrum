import type {
  DocumentDescriptor,
  DocumentSnapshot,
  EventPage,
  WorkspaceInfo
} from "../adapters/types.js";

export const BUS_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export const BUS_CAPABILITIES = [
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
] as const;

export type BusCapability = typeof BUS_CAPABILITIES[number];

export type AgentIdentity = {
  id: string;
  token?: string;
};

export type ConnectionGrant = {
  capabilities: readonly BusCapability[];
  sessionIds: readonly string[];
};

export type AdapterWorkspaceListParams = {
  sessionId: string;
};

export type AdapterWorkspaceListResult = {
  workspaces: WorkspaceInfo[];
};

export type AdapterDocumentListParams = {
  sessionId: string;
  workspaceId: string;
};

export type AdapterDocumentListResult = {
  documents: DocumentDescriptor[];
};

export type AdapterDocumentReadParams = {
  sessionId: string;
  workspaceId: string;
  path: string;
};

export type AdapterDocumentReadResult = {
  document: DocumentSnapshot;
};

export type AdapterDocumentWriteParams = AdapterDocumentReadParams & {
  text: string;
  expectedVersion: number;
};

export type AdapterDocumentWriteResult = AdapterDocumentReadResult;

export type AdapterEventsReadParams = {
  sessionId: string;
  after?: number;
  limit?: number;
};

export type WorkspaceEncoding = "utf8" | "base64";

export type WorkspaceReadParams = {
  sessionId: string;
  path: string;
  encoding?: WorkspaceEncoding;
};

export type WorkspaceReadResult = {
  sessionId: string;
  path: string;
  encoding: WorkspaceEncoding;
  content: string;
  size: number;
  version: string;
  modifiedAt: string;
};

export type WorkspaceWriteParams = {
  sessionId: string;
  path: string;
  content: string;
  encoding?: WorkspaceEncoding;
  expectedVersion?: string | null;
};

export type WorkspaceWriteResult = {
  sessionId: string;
  path: string;
  size: number;
  version: string;
  modifiedAt: string;
};

export type WorkspaceListParams = {
  sessionId: string;
  path?: string;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt: string;
};

export type WorkspaceListResult = {
  sessionId: string;
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
};

export type EventPublishParams = {
  sessionId: string;
  channel: string;
  data: unknown;
};

export type EventSubscribeParams = {
  sessionId: string;
  channel?: string;
};

export type EventSubscription = {
  subscriptionId: string;
  sessionId: string;
  channel?: string;
};

export type BusEvent = {
  id: string;
  sessionId: string;
  channel: string;
  data: unknown;
  publisherId: string;
  publishedAt: string;
};

export type BusRequestMap = {
  "ping": {
    params: Record<string, never>;
    result: { now: string };
  };
  "workspace.read": {
    params: WorkspaceReadParams;
    result: WorkspaceReadResult;
  };
  "workspace.write": {
    params: WorkspaceWriteParams;
    result: WorkspaceWriteResult;
  };
  "workspace.list": {
    params: WorkspaceListParams;
    result: WorkspaceListResult;
  };
  "event.publish": {
    params: EventPublishParams;
    result: { event: BusEvent };
  };
  "event.subscribe": {
    params: EventSubscribeParams;
    result: EventSubscription;
  };
  "event.unsubscribe": {
    params: { subscriptionId: string };
    result: { subscriptionId: string; removed: boolean };
  };
  "adapter.workspace.list": {
    params: AdapterWorkspaceListParams;
    result: AdapterWorkspaceListResult;
  };
  "adapter.document.list": {
    params: AdapterDocumentListParams;
    result: AdapterDocumentListResult;
  };
  "adapter.document.read": {
    params: AdapterDocumentReadParams;
    result: AdapterDocumentReadResult;
  };
  "adapter.document.write": {
    params: AdapterDocumentWriteParams;
    result: AdapterDocumentWriteResult;
  };
  "adapter.events.read": {
    params: AdapterEventsReadParams;
    result: EventPage;
  };
};

export type BusMethod = keyof BusRequestMap;
export type BusParams<M extends BusMethod> = BusRequestMap[M]["params"];
export type BusResult<M extends BusMethod> = BusRequestMap[M]["result"];

export type BusErrorPayload = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
