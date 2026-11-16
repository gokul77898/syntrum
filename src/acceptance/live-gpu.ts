// Live acceptance for the GPU path: provision the guest CUDA runtime, attach a
// real GPU, and run one CUDA workload — the run a rented hour is bought for.
//
// Opt-in and destructive to its own resources only. It creates one temporary
// computer, installs the CUDA runtime, runs one allocation through the real
// scheduler, and deletes everything it created.
//
//   SYNTRUM_WORKER_SSH_HOST=... SYNTRUM_WORKER_SSH_USER=... \
//   npm run test:live-gpu
//
// What it proves, and what it does not:
//   - the guest can load libcudart and create a CUDA context on a real device
//   - nvidia.runtime mounts the host driver libraries (the guest sees the GPU)
//   - a cudaMemset workload runs to completion and reports real usage
//   - the device is released afterwards
// It does not prove multi-container contention, MPS sharing, or MIG, which need
// hardware and separate runs.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import {
  CloudComputerService,
  CloudComputerStore,
  GuestProvisioner,
  IncusWorkerDriver,
  createSshCommandRunner,
  isIncusNotFound
} from "../cloud/index.js";
import { GpuScheduler, GpuStore, NvidiaWorkerAgent } from "../gpu/index.js";
import { errorMessage } from "../runtime/errors.js";

// Modest on purpose: this proves the path, and a small allocation is kind to a
// box rented by the hour.
const ALLOCATION_MB = 64;
const ALLOCATION_SECONDS = 3;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} required`);
  }
  return value;
}

const evidence: Record<string, unknown> = { status: "STARTED" };

async function main(): Promise<void> {
  const host = required("SYNTRUM_WORKER_SSH_HOST");
  const user = required("SYNTRUM_WORKER_SSH_USER");
  const run = createSshCommandRunner({
    host,
    user,
    knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
    identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
  });
  const driver = new IncusWorkerDriver(
    run, undefined, undefined, process.env.SYNTRUM_WORKER_APT_CONF
  );
  const workerHost = `${user}@${host}`;
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-gpu-live-"));
  const databasePath = join(dataRoot, "cloud.sqlite");
  const store = new CloudComputerStore(databasePath);
  const service = new CloudComputerService({
    store, driver, workerHost, desktopEnabled: false
  });
  const provisioner = new GuestProvisioner(
    async (id, args, timeoutMs) => (await driver.execute?.(id, args, timeoutMs)) ?? "",
    Boolean(process.env.SYNTRUM_WORKER_APT_CONF)
  );
  const gpuScheduler = new GpuScheduler(
    new GpuStore(databasePath),
    store,
    new Map([[workerHost, new NvidiaWorkerAgent(run)]])
  );

  let computerId: string | undefined;
  let failed = false;

  try {
    // Refuse before renting anything: without a driver on the host, every
    // failure below would be a symptom of the same absence, and diagnosing it
    // costs the same hourly rate this harness exists to protect.
    let workerSmi: string;
    try {
      workerSmi = await run([
        "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"
      ]);
    } catch (error) {
      evidence.status = "BLOCKED_NO_NVIDIA_HARDWARE";
      evidence.reason = errorMessage(error, "nvidia-smi is unavailable on this worker");
      evidence.hint =
        "Install the NVIDIA driver on the worker (bootstrap-worker.sh leaves that to the " +
        "provider image), then re-run with SYNTRUM_GPU=yes.";
      console.log(JSON.stringify(evidence, null, 2));
      process.exitCode = 1;
      return;
    }
    evidence.workerGpus = workerSmi.trim().split("\n");

    const computer = await service.create({
      cpu: 2, memoryMb: 2048, diskGb: 10, desktopEnabled: false
    });
    computerId = computer.id;
    evidence.created = { id: computer.id, status: computer.status };

    // Before: the guest should have no CUDA runtime at all, which is the state
    // the provisioning step exists to fix.
    evidence.cudaBeforeInstall = await driver.execute?.(computerId, [
      "sh", "-c",
      "python3 -c 'import ctypes; ctypes.CDLL(\"libcudart.so.12\")' 2>&1 | tail -1"
    ]).then(value => value.trim() || "(no output)")
      .catch(error => `(unavailable: ${errorMessage(error, "failed")})`);

    evidence.installed = await provisioner.installCudaRuntime(computerId);

    // The allocation goes through the real scheduler, so this exercises the
    // capacity accounting, the attachment, the non-live nvidia.runtime restart,
    // the in-guest preflight, and the release — not a bespoke shortcut.
    const allocation = await gpuScheduler.allocate({
      computerId,
      memoryMb: ALLOCATION_MB,
      durationSec: ALLOCATION_SECONDS,
      workload: "cuda-memset"
    });
    evidence.allocation = { id: allocation.id, gpuUuid: allocation.gpuUuid };
    await gpuScheduler.idle();

    const finished = gpuScheduler.listAllocations().find(item => item.id === allocation.id)!;
    evidence.allocationStatus = finished.status;
    if (finished.error) evidence.allocationError = finished.error;
    if (finished.status !== "succeeded") {
      throw new Error(`Allocation ${finished.status}: ${finished.error ?? "no error recorded"}`);
    }
    if (!finished.releasedAt) {
      throw new Error("The device was not released after the workload");
    }
    evidence.metrics = gpuScheduler.listMetrics(allocation.id).map(metric => ({
      utilizationPercent: metric.utilizationPercent,
      usedMemoryMb: metric.usedMemoryMb,
      temperatureC: metric.temperatureC,
      recordedAt: metric.recordedAt
    }));

    // The mount is the whole point of the restart: the guest must see the
    // device, not just the library.
    evidence.gpuInsideGuest = await driver.execute?.(computerId, ["nvidia-smi", "-L"])
      .then(value => value.trim())
      .catch(error => `(unavailable: ${errorMessage(error, "failed")})`);

    evidence.status = "PASSED";
  } catch (error) {
    failed = true;
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    gpuScheduler.close();
    if (computerId && failed && process.env.SYNTRUM_KEEP_FAILED === "1") {
      evidence.cleanup = { container: "kept for inspection", id: computerId };
    } else if (computerId) {
      try {
        await service.destroy(computerId);
        const gone = await driver.inspect(computerId).catch(error => {
          if (isIncusNotFound(error)) return "deleted";
          throw error;
        });
        evidence.cleanup = { container: gone };
      } catch (error) {
        evidence.cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    service.close();
  }

  console.log(JSON.stringify(evidence, null, 2));
  if (failed) {
    process.exitCode = 1;
  }
}

await main();
