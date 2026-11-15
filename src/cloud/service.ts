import { randomUUID } from "node:crypto";

import { CloudComputerStore } from "./store.js";
import {
  CloudError,
  type CloudComputer,
  type ComputerSpec,
  type CreateComputerInput,
  type WorkerDriver
} from "./types.js";

const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_DISK_GB = 40;
const DEFAULT_IMAGE = "images:ubuntu/24.04";

export type CloudComputerServiceOptions = {
  store: CloudComputerStore;
  driver: WorkerDriver;
  workerHost: string;
  desktopEnabled?: boolean;
};

export class CloudComputerService {
  private readonly store: CloudComputerStore;
  private readonly driver: WorkerDriver;
  private readonly workerHost: string;
  private readonly desktopEnabled: boolean;
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(options: CloudComputerServiceOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.workerHost = options.workerHost;
    this.desktopEnabled = options.desktopEnabled !== false;
  }

  list(): CloudComputer[] {
    return this.store.list();
  }

  get(id: string): CloudComputer {
    this.validateId(id);
    return this.requireActive(id);
  }

  async create(input: CreateComputerInput = {}): Promise<CloudComputer> {
    const id = randomUUID();
    const cpu = input.cpu ?? DEFAULT_CPU;
    const memoryMb = input.memoryMb ?? DEFAULT_MEMORY_MB;
    const diskGb = input.diskGb ?? DEFAULT_DISK_GB;
    if (!Number.isSafeInteger(cpu) || cpu < 1 || cpu > 64) {
      throw new CloudError(400, "INVALID_CPU", "CPU must be between 1 and 64");
    }
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 512 || memoryMb > 262_144) {
      throw new CloudError(400, "INVALID_MEMORY", "Memory must be between 512 and 262144 MiB");
    }
    if (!Number.isSafeInteger(diskGb) || diskGb < 5 || diskGb > 2048) {
      throw new CloudError(400, "INVALID_DISK", "Disk must be between 5 and 2048 GiB");
    }

    const now = new Date().toISOString();
    const desktopEnabled = this.desktopEnabled && input.desktopEnabled !== false;
    const spec: ComputerSpec = {
      id,
      workerHost: this.workerHost,
      image: DEFAULT_IMAGE,
      cpu,
      memoryMb,
      diskGb,
      storageVolume: `syntrum-workspace-${id}`,
      desktopPort: this.store.nextDesktopPort(),
      desktopEnabled
    };
    this.store.insert({
      ...spec,
      desktopEnabled,
      status: "provisioning",
      createdAt: now,
      updatedAt: now
    });
    return this.runExclusive(id, async () => {
      try {
        await this.driver.create(spec);
        return this.store.updateStatus(id, "running");
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_CREATE_FAILED", this.message(error), { computerId: id });
      }
    });
  }

  start(id: string): Promise<CloudComputer> {
    return this.transition(id, "starting", () => this.driver.start(id), "running");
  }

  stop(id: string): Promise<CloudComputer> {
    return this.transition(id, "stopping", () => this.driver.stop(id), "stopped");
  }

  restart(id: string): Promise<CloudComputer> {
    return this.transition(id, "restarting", () => this.driver.restart(id), "running");
  }

  destroy(id: string): Promise<CloudComputer> {
    this.validateId(id);
    return this.runExclusive(id, async () => {
      const computer = this.store.get(id);
      if (computer.status === "deleted") {
        return computer;
      }
      this.store.updateStatus(id, "deleting");
      try {
        await this.driver.destroy(computer);
        return this.store.updateStatus(id, "deleted");
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_DESTROY_FAILED", this.message(error));
      }
    });
  }

  details(id: string) {
    this.validateId(id);
    if (!this.driver.inspectDetails) {
      throw new CloudError(501, "DETAILS_NOT_SUPPORTED", "Worker does not expose resource details");
    }
    this.requireActive(id);
    return this.driver.inspectDetails(id);
  }

  execute(id: string, args: readonly string[], timeoutMs?: number): Promise<string> {
    this.validateId(id);
    if (this.requireActive(id).status !== "running") {
      throw new CloudError(409, "COMPUTER_NOT_RUNNING", "Cloud computer must be running");
    }
    if (!this.driver.execute) {
      throw new CloudError(501, "EXEC_NOT_SUPPORTED", "Worker does not expose guest execution");
    }
    if (
      args.length === 0 ||
      args.length > 32 ||
      args.some(value => typeof value !== "string" || value.length === 0 || value.length > 4096)
    ) {
      throw new CloudError(400, "INVALID_COMMAND", "Invalid guest command");
    }
    return this.driver.execute(id, args, timeoutMs);
  }

  access(id: string) {
    const computer = this.requireActive(id);
    if (computer.status !== "running") {
      throw new CloudError(409, "DESKTOP_NOT_READY", "Cloud desktop is not running");
    }
    if (!computer.desktopEnabled) {
      throw new CloudError(409, "DESKTOP_NOT_PROVISIONED", "This computer has no desktop");
    }
    const localUrl = `http://127.0.0.1:${computer.desktopPort}/vnc.html`;
    return {
      computerId: id,
      protocol: "noVNC over SSH tunnel",
      sshTunnelCommand: `ssh -L ${computer.desktopPort}:127.0.0.1:${computer.desktopPort} ${this.workerHost}`,
      browserUrlAfterTunnel: localUrl,
      publicExposure: false
    };
  }

  async reconcile(): Promise<CloudComputer[]> {
    for (const computer of this.store.list()) {
      try {
        const status = await this.driver.inspect(computer.id);
        this.store.updateStatus(computer.id, status);
      } catch (error) {
        this.store.updateStatus(computer.id, "error", this.message(error));
      }
    }
    return this.store.list();
  }

  close(): void {
    this.store.close();
  }

  private async transition(
    id: string,
    pending: CloudComputer["status"],
    operation: () => Promise<void>,
    completed: CloudComputer["status"]
  ): Promise<CloudComputer> {
    this.validateId(id);
    return this.runExclusive(id, async () => {
      this.requireActive(id);
      this.store.updateStatus(id, pending);
      try {
        await operation();
        return this.store.updateStatus(id, completed);
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_OPERATION_FAILED", this.message(error));
      }
    });
  }

  private runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.operations.set(id, result);
    void result.finally(() => {
      if (this.operations.get(id) === result) {
        this.operations.delete(id);
      }
    }).catch(() => undefined);
    return result;
  }

  private requireActive(id: string): CloudComputer {
    const computer = this.store.get(id);
    if (computer.status === "deleted") {
      throw new CloudError(409, "COMPUTER_DELETED", "Cloud computer has been deleted");
    }
    return computer;
  }

  private validateId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new CloudError(400, "INVALID_COMPUTER_ID", "Invalid cloud computer ID");
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : "Remote worker operation failed";
  }
}
