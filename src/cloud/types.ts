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
  /** Absent for computers created before accounts existed. */
  ownerId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateComputerInput = {
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  desktopEnabled?: boolean;
  /** Which registered worker to create on; defaults to the control plane's own. */
  workerHost?: string;
};

export type ComputerSpec = Omit<Required<CreateComputerInput>, "desktopEnabled" | "workerHost"> & {
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
  // Branching a computer: the target is a full copy of the source's disk.
  fork?(sourceId: string, targetId: string): Promise<void>;
}

/** A fork request, before the service assigns an id and a port. */
export type ForkComputerInput = {
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  desktopEnabled?: boolean;
};

/**
 * Installs the in-guest agent runtime during create().
 *
 * Deliberately an interface, not a concrete class: `GuestProvisioner` needs a
 * guest executor and a byte-upload strategy, and the service should not have to
 * know whether those are scp, a pipe over ssh, or a test double. This is the
 * same seam `installBus`'s `upload` option already uses.
 */
export interface GuestRuntimeProvisioner {
  /**
   * Produces the daemon's compiled JavaScript on the host.
   *
   * Part of this interface, not of the service: it is the one step that shells
   * out to a real compiler, and keeping it here is what lets a test double
   * provision a guest without spawning `tsc`.
   */
  compile(outputRoot: string): Promise<{ directory: string; modules: string }>;
  installNode(id: string, version: string): Promise<unknown>;
  installBus(
    id: string,
    options: {
      compiledDirectory: string;
      agents: readonly { id: string; token: string }[];
      upload: (id: string, localDirectory: string, remoteDirectory: string) => Promise<void>;
    }
  ): Promise<unknown>;
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
