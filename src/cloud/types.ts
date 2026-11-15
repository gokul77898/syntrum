export type CloudComputerStatus =
  | "provisioning"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "deleting"
  | "deleted"
  | "error";

export type CloudComputer = {
  id: string;
  workerHost: string;
  image: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  storageVolume: string;
  desktopPort: number;
  desktopEnabled: boolean;
  status: CloudComputerStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateComputerInput = {
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  desktopEnabled?: boolean;
};

export type ComputerSpec = Omit<Required<CreateComputerInput>, "desktopEnabled"> & {
  desktopEnabled?: boolean;
  id: string;
  workerHost: string;
  image: string;
  storageVolume: string;
  desktopPort: number;
};

export type ComputerDetails = {
  status: CloudComputerStatus;
  architecture: string;
  ipAddresses: string[];
  memoryUsageBytes: number;
  memoryTotalBytes: number;
  cpuUsageNanoseconds: number;
  processes: number;
};

export interface WorkerDriver {
  create(spec: ComputerSpec): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  destroy(spec: Pick<ComputerSpec, "id" | "storageVolume">): Promise<void>;
  inspect(id: string): Promise<CloudComputerStatus>;
  inspectDetails?(id: string): Promise<ComputerDetails>;
  // Optional because a worker without desktop support has nothing to verify.
  verifyDesktop?(id: string): Promise<void>;
  execute?(id: string, args: readonly string[], timeoutMs?: number): Promise<string>;
}

export type CommandRunner = (
  args: readonly string[],
  timeoutMs?: number,
  execFile?: ExecFile
) => Promise<string>;

export type ExecFile = (file: string, args: readonly string[], options: {
  encoding: BufferEncoding;
  timeout: number;
  maxBuffer: number;
  shell: false;
}, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;

export class CloudError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CloudError";
  }
}
