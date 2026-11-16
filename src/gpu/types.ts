export type GpuSharingMode = "time-slice" | "mps" | "mig" | "dedicated";
export type GpuWorkloadKind = "nvidia-smi" | "cuda-memset";

/**
 * The CUDA Runtime soname every guest workload loads.
 *
 * One constant, because it is the exact thing that was wrong: Ubuntu 24.04's
 * only CUDA Runtime package is `libcudart12`, which ships libcudart.so.12 and
 * nothing named libcudart.so.1 anywhere in the archive. A workload asking for
 * .so.1 cannot dlopen on a correctly provisioned box.
 */
export const CUDA_RUNTIME_LIBRARY = "libcudart.so.12";

/**
 * The smallest program that proves the guest can reach a GPU at all: load the
 * runtime, create a context, allocate, free.
 *
 * Shared deliberately. The provisioner proves the library loads; the worker
 * agent proves a context can be created once the device is attached. Both must
 * exercise the same soname the real workload uses, or neither proves anything
 * about the workload.
 */
export const CUDA_PROBE_SOURCE = `
import ctypes, sys
cuda = ctypes.CDLL("${CUDA_RUNTIME_LIBRARY}")
def check(result):
    if result != 0:
        raise RuntimeError("CUDA error " + str(result))
check(cuda.cudaSetDevice(0))
pointer = ctypes.c_void_p()
check(cuda.cudaMalloc(ctypes.byref(pointer), ctypes.c_size_t(int(sys.argv[1]))))
check(cuda.cudaFree(pointer))
print("syntrum-cuda-ready")
`;

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
