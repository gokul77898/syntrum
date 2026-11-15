import type { CommandRunner } from "../cloud/types.js";
import type {
  GpuAllocation,
  GpuDevice,
  GpuMetric,
  GpuWorkerAgent
} from "./types.js";

const CUDA_MEMSET_SOURCE = `
import ctypes, sys, time
bytes_to_allocate = int(sys.argv[1])
duration = float(sys.argv[2])
cuda = ctypes.CDLL("libcudart.so.1")
def check(result):
    if result != 0:
        raise RuntimeError("CUDA error " + str(result))
check(cuda.cudaSetDevice(0))
pointer = ctypes.c_void_p()
check(cuda.cudaMalloc(ctypes.byref(pointer), ctypes.c_size_t(bytes_to_allocate)))
try:
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        check(cuda.cudaMemset(pointer, 0xAB, ctypes.c_size_t(bytes_to_allocate)))
        time.sleep(0.1)
finally:
    check(cuda.cudaFree(pointer))
`;

function deviceName(gpuUuid: string): string {
  return `gpu${gpuUuid.replaceAll("-", "").slice(0, 12)}`;
}

export class NvidiaWorkerAgent implements GpuWorkerAgent {
  constructor(private readonly run: CommandRunner) {}

  async discover(): Promise<GpuDevice[]> {
    const output = await this.run([
      "nvidia-smi",
      "--query-gpu=uuid,index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits"
    ]);
    const devices: GpuDevice[] = [];
    for (const line of output.split("\n").filter(Boolean)) {
      const [uuid, index, model, total, used, utilization, temperature] =
        line.split(",").map(value => value.trim());
      devices.push({
        workerHost: "",
        uuid,
        index: Number(index),
        model,
        totalMemoryMb: Number(total),
        usedMemoryMb: Number(used),
        utilizationPercent: Number(utilization),
        temperatureC: Number(temperature),
        migCapable: await this.queryMigCapability(uuid)
      });
    }
    return devices;
  }

  async execute(allocation: GpuAllocation): Promise<void> {
    if (allocation.mode === "mig") {
      throw new Error("MIG allocation requires a pre-provisioned MIG partition");
    }
    if (allocation.mode === "mps") {
      await this.run(["nvidia-cuda-mps-control", "-d"]);
    }
    await this.incus([
      "config", "device", "add", allocation.computerId,
      deviceName(allocation.gpuUuid), "gpu", `id=${await this.gpuIndex(allocation.gpuUuid)}`
    ]);
    if (allocation.workload === "nvidia-smi") {
      await this.incus(["exec", allocation.computerId, "--", "nvidia-smi"]);
      return;
    }

    const environment = [
      "CUDA_VISIBLE_DEVICES=0",
      ...(allocation.mode === "mps"
        ? [`CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=${allocation.computePercent}`]
        : [])
    ];
    await this.incus([
      "exec", allocation.computerId,
      ...environment.flatMap(value => ["--env", value]),
      "--", "python3", "-c", CUDA_MEMSET_SOURCE,
      String(allocation.memoryMb * 1024 * 1024),
      String(allocation.durationSec)
    ], (allocation.durationSec + 30) * 1000);
  }

  async release(allocation: GpuAllocation): Promise<void> {
    await this.incus([
      "config", "device", "remove", allocation.computerId,
      deviceName(allocation.gpuUuid)
    ]);
  }

  async measure(gpuUuid: string): Promise<GpuMetric> {
    const devices = await this.discover();
    const device = devices.find(item => item.uuid === gpuUuid);
    if (!device) {
      throw new Error(`GPU ${gpuUuid} is not present on the worker`);
    }
    return {
      gpuUuid,
      utilizationPercent: device.utilizationPercent,
      usedMemoryMb: device.usedMemoryMb,
      temperatureC: device.temperatureC,
      recordedAt: new Date().toISOString()
    };
  }

  private incus(args: readonly string[], timeoutMs?: number): Promise<string> {
    return this.run(["incus", ...args], timeoutMs);
  }

  private async gpuIndex(gpuUuid: string): Promise<number> {
    const devices = await this.discover();
    const device = devices.find(item => item.uuid === gpuUuid);
    if (!device) {
      throw new Error(`GPU ${gpuUuid} is not present on the worker`);
    }
    return device.index;
  }

  private async queryMigCapability(gpuUuid: string): Promise<boolean> {
    try {
      const output = await this.run([
        "nvidia-smi", "--query-gpu=mig.mode.current",
        "--format=csv,noheader", `--id=${gpuUuid}`
      ]);
      return /enabled|disabled/i.test(output);
    } catch {
      return false;
    }
  }
}
