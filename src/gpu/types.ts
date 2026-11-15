export type GpuSharingMode = "time-slice" | "mps" | "mig" | "dedicated";
export type GpuWorkloadKind = "nvidia-smi" | "cuda-memset";

export type GpuDevice = {
  workerHost: string;
  uuid: string;
  index: number;
  model: string;
  totalMemoryMb: number;
  usedMemoryMb: number;
  utilizationPercent: number;
  temperatureC: number;
  migCapable: boolean;
};

export type GpuAllocation = {
  id: string;
  computerId: string;
  workerHost: string;
  gpuUuid: string;
  memoryMb: number;
  computePercent: number;
  mode: GpuSharingMode;
  workload: GpuWorkloadKind;
  durationSec: number;
  status: "running" | "succeeded" | "failed" | "error";
  error?: string;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
};

export type GpuMetric = {
  allocationId?: string;
  gpuUuid: string;
  utilizationPercent: number;
  usedMemoryMb: number;
  temperatureC: number;
  recordedAt: string;
};

export type GpuAllocationRequest = {
  computerId: string;
  memoryMb: number;
  computePercent?: number;
  mode?: GpuSharingMode;
  workload?: GpuWorkloadKind;
  durationSec?: number;
};

export interface GpuWorkerAgent {
  discover(): Promise<GpuDevice[]>;
  execute(allocation: GpuAllocation): Promise<void>;
  release(allocation: GpuAllocation): Promise<void>;
  measure(gpuUuid: string): Promise<GpuMetric>;
}

export class GpuError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GpuError";
  }
}
