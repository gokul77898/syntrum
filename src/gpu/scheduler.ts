import { randomUUID } from "node:crypto";

import type { CloudComputerStore } from "../cloud/store.js";
import { GpuStore } from "./store.js";
import {
  GpuError,
  type GpuAllocation,
  type GpuAllocationRequest,
  type GpuDevice,
  type GpuMetric,
  type GpuWorkerAgent
} from "./types.js";

export class GpuScheduler {
  private readonly operations = new Map<string, Promise<void>>();
  private scheduling: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: GpuStore,
    private readonly computers: CloudComputerStore,
    private readonly agents: ReadonlyMap<string, GpuWorkerAgent>
  ) {}

  async refreshInventory(): Promise<GpuDevice[]> {
    for (const [workerHost, agent] of this.agents) {
      // A worker with no GPU at all is a normal fleet member (an arm64 dev box,
      // say), and `nvidia-smi` failing there must not fail discovery for every
      // other worker — one CPU-only worker would otherwise make /gpus error and
      // every allocation fail, including on the GPU worker that would have
      // served it.
      const devices = await agent.discover().catch(() => []);
      for (const device of devices) {
        this.store.upsertDevice({ ...device, workerHost });
      }
    }
    return this.store.listDevices();
  }

  allocate(request: GpuAllocationRequest): Promise<GpuAllocation> {
    return this.serialize(() => this.performAllocation(request));
  }

  listDevices(): GpuDevice[] {
    return this.store.listDevices();
  }

  listAllocations(activeOnly = false): GpuAllocation[] {
    return this.store.listAllocations(activeOnly);
  }

  listMetrics(allocationId?: string): GpuMetric[] {
    return this.store.listMetrics(allocationId);
  }

  async idle(): Promise<void> {
    await Promise.allSettled(this.operations.values());
  }

  async recover(): Promise<void> {
    await this.serialize(async () => {
      for (const allocation of this.store.listAllocations(true)) {
        this.store.updateAllocation(
          allocation.id,
          "error",
          "Scheduler restarted while workload outcome was uncertain"
        );
        const agent = this.agents.get(allocation.workerHost);
        if (agent) {
          await agent.release(allocation).catch(() => undefined);
        }
        this.store.updateAllocation(
          allocation.id,
          "error",
          "Scheduler restarted while workload outcome was uncertain",
          new Date().toISOString()
        );
      }
    });
  }

  close(): void {
    this.store.close();
  }

  private async performAllocation(request: GpuAllocationRequest): Promise<GpuAllocation> {
    const computer = this.computers.get(request.computerId);
    if (computer.status !== "running") {
      throw new GpuError(409, "COMPUTER_NOT_RUNNING", "Cloud computer is not running");
    }
    const agent = this.agents.get(computer.workerHost);
    if (!agent) {
      throw new GpuError(404, "WORKER_NOT_FOUND", "No GPU agent for this worker");
    }
    const memoryMb = request.memoryMb;
    const computePercent = request.computePercent ?? 50;
    const durationSec = request.durationSec ?? 2;
    const mode = request.mode ?? "time-slice";
    const workload = request.workload ?? "cuda-memset";
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 1 || memoryMb > 1_048_576) {
      throw new GpuError(400, "INVALID_GPU_MEMORY", "Invalid GPU memory request");
    }
    if (!Number.isSafeInteger(computePercent) || computePercent < 1 || computePercent > 100) {
      throw new GpuError(400, "INVALID_COMPUTE_QUOTA", "Compute quota must be 1-100 percent");
    }
    if (!Number.isSafeInteger(durationSec) || durationSec < 1 || durationSec > 3600) {
      throw new GpuError(400, "INVALID_WORKLOAD_DURATION", "Duration must be 1-3600 seconds");
    }
    if (mode === "mig") {
      throw new GpuError(
        409,
        "MIG_REQUIRES_PREPROVISIONED_PARTITION",
        "MIG requires a pre-provisioned partition; dynamic MIG creation is not implemented"
      );
    }
    if (workload !== "cuda-memset" && workload !== "nvidia-smi") {
      throw new GpuError(400, "INVALID_WORKLOAD", "Unsupported GPU workload");
    }

    await this.refreshInventory();
    const active = this.store.listAllocations(true);
    const candidates = this.store.listDevices(computer.workerHost).filter(device => {
      const onDevice = active.filter(item => item.gpuUuid === device.uuid);
      if (mode === "dedicated" && (onDevice.length > 0 || device.usedMemoryMb > 0)) {
        return false;
      }
      if (mode !== "dedicated" && onDevice.some(item => item.mode === "dedicated")) {
        return false;
      }
      const reservedMemory = onDevice.reduce((sum, item) => sum + item.memoryMb, 0);
      const available = device.totalMemoryMb - device.usedMemoryMb - reservedMemory;
      const computeUsed = onDevice.reduce((sum, item) => sum + item.computePercent, 0);
      return available >= memoryMb && computeUsed + computePercent <= 100;
    }).sort((left, right) => {
      const leftFree = left.totalMemoryMb - left.usedMemoryMb;
      const rightFree = right.totalMemoryMb - right.usedMemoryMb;
      return rightFree - leftFree;
    });
    const device = candidates[0];
    if (!device) {
      throw new GpuError(
        409,
        "GPU_CAPACITY_EXHAUSTED",
        "No GPU has enough memory and compute capacity for this request"
      );
    }

    const now = new Date().toISOString();
    const allocation: GpuAllocation = {
      id: randomUUID(),
      computerId: computer.id,
      workerHost: computer.workerHost,
      gpuUuid: device.uuid,
      memoryMb,
      computePercent,
      mode,
      workload,
      durationSec,
      status: "running",
      createdAt: now,
      updatedAt: now
    };
    this.store.insertAllocation(allocation);
    const operation = this.execute(allocation).finally(() => {
      this.operations.delete(allocation.id);
    });
    this.operations.set(allocation.id, operation);
    return allocation;
  }

  private async execute(allocation: GpuAllocation): Promise<void> {
    const agent = this.agents.get(allocation.workerHost)!;
    try {
      await this.measure(allocation);
      await agent.execute(allocation);
      this.store.updateAllocation(allocation.id, "succeeded");
    } catch (error) {
      this.store.updateAllocation(
        allocation.id,
        "failed",
        error instanceof Error ? error.message : "GPU workload failed"
      );
    } finally {
      await this.measure(allocation).catch(() => undefined);
      try {
        await agent.release(allocation);
        this.store.updateAllocation(
          allocation.id,
          this.store.getAllocation(allocation.id).status,
          this.store.getAllocation(allocation.id).error,
          new Date().toISOString()
        );
      } catch (error) {
        this.store.updateAllocation(
          allocation.id,
          "error",
          error instanceof Error ? error.message : "GPU release failed"
        );
      }
    }
  }

  private async measure(allocation: GpuAllocation): Promise<void> {
    const agent = this.agents.get(allocation.workerHost)!;
    const metric = await agent.measure(allocation.gpuUuid);
    this.store.recordMetric({ ...metric, allocationId: allocation.id });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.scheduling.catch(() => undefined).then(operation);
    this.scheduling = result;
    return result;
  }
}
