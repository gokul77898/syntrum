export type ApplicationStatus =
  | "running"
  | "termination_requested"
  | "exited"
  | "unknown";

export type ProcessOrigin = "launched" | "pre_existing" | "shared" | "unknown";
export type ProcessIdentity = "unverified" | "verified" | "mismatch";

export type ManagedApplication = {
  id: string;
  name: string;
  bundleIdentifier: string;
  bundleURL: string;
  pid: number;
  launchDate?: string;
  launchedAt: string;
  status: ApplicationStatus;
  processOrigin: ProcessOrigin;
  processIdentity: ProcessIdentity;
  lastCheckedAt?: string;
  lastError?: string;
  exitedAt?: string;
  terminationRequestedAt?: string;
};

export type Session = {
  id: string;
  status: "active" | "stopped";
  createdAt: string;
  applications: ManagedApplication[];
};

export type RuntimeEvent = {
  id: number;
  sessionId: string;
  applicationId?: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export type SessionResource = {
  sessionId: string;
  workspaceRoot: string;
  adapterSocketPath: string;
  adapterToken: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentGrant = {
  agentId: string;
  sessionId: string;
  tokenHash: string;
  capabilities: string[];
  createdAt: string;
};

export type NativeLaunchOptions = {
  workspacePath?: string;
  arguments?: string[];
  environment?: Record<string, string>;
  activates?: boolean;
  newInstance?: boolean;
};

export type NativeResult = {
  ok: boolean;
  available?: boolean;
  pid?: number;
  running?: boolean;
  terminationRequested?: boolean;
  name?: string;
  bundleIdentifier?: string;
  bundleURL?: string;
  launchDate?: string;
  preExisting?: boolean;
  alreadyRunning?: boolean;
  processReused?: boolean;
  processExistedBeforeLaunch?: boolean;
  actualBundleIdentifier?: string;
  actualLaunchDate?: string;
  error?: string;
};

export interface NativeManager {
  launch(bundleIdentifier: string, options?: NativeLaunchOptions): Promise<NativeResult>;
  inspect(pid: number, bundleIdentifier: string): Promise<NativeResult>;
  terminate(pid: number, bundleIdentifier: string): Promise<NativeResult>;
  frontmost(): Promise<NativeResult>;
}

export type LogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  context?: Record<string, unknown>;
};

export type Logger = (entry: LogEntry) => void;

export type LaunchResult = {
  application: ManagedApplication;
  created: boolean;
};

export type TerminationResult = {
  application: ManagedApplication;
  alreadyExited: boolean;
  terminationRequested?: boolean;
};
