import type { CommandRunner } from "../cloud/types.js";
import { CUDA_PROBE_SOURCE, CUDA_RUNTIME_LIBRARY } from "./types.js";
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
cuda = ctypes.CDLL("${CUDA_RUNTIME_LIBRARY}")
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

// The MPS control daemon's pipe directory on the host. Mounted into the
// container so several containers can share one CUDA context through MPS.
const MPS_PIPE_DIRECTORY = "/tmp/nvidia-mps";

function mpsPipeDeviceName(gpuUuid: string): string {
  return `mps-pipe-${gpuUuid.replaceAll("-", "").slice(0, 12)}`;
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
    // nvidia.runtime: without it Incus does not bind the host's NVIDIA
    // userspace libraries and nvidia-smi into the guest, so every CUDA call
    // fails on driver/library version mismatch even with the device attached.
    //
    // It is not a live-updatable option ("Live update: no" in the Incus
    // instance-option reference), so the libraries are mounted when the
    // container *next starts*. Setting it on a running container and carrying
    // on would attach a device that still cannot compute. The restart is
    // therefore the last step before the workload, so a single start applies
    // both the libraries and the device — and it happens at most once per
    // computer, because the option is left set afterwards and the next
    // allocation reads it back and skips the restart. Restarting interrupts an
    // open desktop session; the guest's own syntrum-* units bring it back.
    const hadRuntime = await this.hasRuntime(allocation.computerId);
    await this.incus([
      "config", "set", allocation.computerId, "nvidia.runtime=true"
    ]);
    await this.incus([
      "config", "device", "add", allocation.computerId,
      deviceName(allocation.gpuUuid), "gpu", `id=${await this.gpuIndex(allocation.gpuUuid)}`
    ]);
    if (allocation.mode === "mps") {
      // MPS clients reach the control daemon through its pipe directory, so it
      // must be visible inside the container and named in the environment.
      await this.incus([
        "config", "device", "add", allocation.computerId,
        mpsPipeDeviceName(allocation.gpuUuid), "disk",
        `source=${MPS_PIPE_DIRECTORY}`, "path=/tmp/nvidia-mps"
      ]);
    }
    if (!hadRuntime) {
      await this.incus(["restart", allocation.computerId], 120_000);
    }
    if (allocation.workload === "nvidia-smi") {
      await this.incus(["exec", allocation.computerId, "--", "nvidia-smi"]);
      return;
    }

    // Only a CUDA workload needs the guest's own CUDA runtime package; the
    // nvidia-smi smoke path above needs just the driver the runtime mounts.
    // Proving the soname loads here means a missing libcudart12 reports itself
    // as a provisioning gap instead of a CUDA error partway through the run.
    await this.assertCudaAvailable(allocation.computerId);

    const environment = [
      "CUDA_VISIBLE_DEVICES=0",
      ...(allocation.mode === "mps"
        ? [
            `CUDA_MPS_PIPE_DIRECTORY=${MPS_PIPE_DIRECTORY}`,
            `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=${allocation.computePercent}`
          ]
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

  /**
   * Whether the runtime libraries are already mounted into the guest.
   *
   * An unset key and an unreadable one both count as "not yet": the worst case
   * that way is one unnecessary restart, never a device attached to a guest
   * that has no libraries to use it.
   */
  private async hasRuntime(computerId: string): Promise<boolean> {
    try {
      const value = await this.incus(["config", "get", computerId, "nvidia.runtime"]);
      return value.trim() === "true";
    } catch {
      return false;
    }
  }

  private async assertCudaAvailable(computerId: string): Promise<void> {
    try {
      await this.incus([
        "exec", computerId, "--",
        "python3", "-c", CUDA_PROBE_SOURCE, "1048576"
      ], 60_000);
    } catch (error) {
      throw new Error(
        `Guest cannot run CUDA: ${error instanceof Error ? error.message : "probe failed"}. ` +
        "Provision the guest CUDA runtime (GuestProvisioner.installCudaRuntime) " +
        "before allocating a GPU to this computer."
      );
    }
  }

  async release(allocation: GpuAllocation): Promise<void> {
    await this.incus([
      "config", "device", "remove", allocation.computerId,
      deviceName(allocation.gpuUuid)
    ]);
    if (allocation.mode === "mps") {
      // Best-effort: the container may already be gone when releasing.
      await this.incus([
        "config", "device", "remove", allocation.computerId,
        mpsPipeDeviceName(allocation.gpuUuid)
      ]).catch(() => undefined);
    }
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
