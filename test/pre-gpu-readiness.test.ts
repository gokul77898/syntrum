import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
  OPERATOR,
  clockNeedsAptOverride,
  nodeRuntimePackages,
  nodeInstallScript,
  type Caller,
  type CloudComputer,
  type WorkerDriver
} from "../src/cloud/index.js";
import { AccountStore } from "../src/cloud/accounts.js";
import { NvidiaWorkerAgent } from "../src/gpu/nvidia-worker-agent.js";
import type { GpuAllocation } from "../src/gpu/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

/* ── Pre-GPU hardware readiness ───────────────────────────────────────
 * Everything here is provable on a development machine. Each item exists
 * because getting it wrong wastes paid GPU rental time on a bug that had
 * nothing to do with the GPU.
 */

// ── 1. GPU attachment into Incus ─────────────────────────────────────────

function gpuAllocation(overrides: Partial<GpuAllocation> = {}): GpuAllocation {
  return {
    id: "allocation-1",
    computerId: "computer-1",
    workerHost: "syntrum@worker",
    gpuUuid: "GPU-abc123def456",
    memoryMb: 512,
    computePercent: 40,
    mode: "time-slice",
    workload: "cuda-memset",
    durationSec: 1,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function agentWith(commands: string[][], runtimeAlreadySet = false) {
  return new NvidiaWorkerAgent(async args => {
    commands.push([...args]);
    if (args.includes("--query-gpu=mig.mode.current")) return "Disabled";
    if (args[1] === "config" && args[2] === "get") {
      return runtimeAlreadySet ? "true" : "";
    }
    if (args[0] === "nvidia-smi" && String(args[1]).startsWith("--query-gpu=")) {
      return "GPU-abc123def456, 0, NVIDIA T4, 16384, 0, 0, 40";
    }
    return "";
  });
}

// The agent runs a CUDA preflight exec before the workload, so "the first exec"
// is no longer the workload. Select the one carrying the memset source.
function workloadExec(commands: string[][]): string[] {
  const execution = commands.find(args =>
    args[1] === "exec" && args.some(value => value.includes("cudaMemset"))
  );
  assert.ok(execution, "the CUDA workload must run");
  return execution!;
}

function indexOfCommand(commands: string[][], match: (args: string[]) => boolean): number {
  return commands.findIndex(match);
}

test("a GPU allocation sets nvidia.runtime so the guest gets the driver", async () => {
  const commands: string[][] = [];
  await agentWith(commands).execute(gpuAllocation());
  // Without this, the device node exists but the userspace libraries do not,
  // and every CUDA call fails on a driver/library version mismatch.
  assert.ok(
    commands.some(args => args.includes("nvidia.runtime=true")),
    "nvidia.runtime=true must be set on the container"
  );
});

// The agent's argv always begins "incus", so these helpers match on content
// rather than a fixed index: a positional assertion silently passes when the
// argument order shifts.
function deviceAdds(commands: string[][]): string[][] {
  return commands.filter(args => {
    const at = args.indexOf("device");
    return at !== -1 && args[at + 1] === "add";
  });
}

function deviceRemoves(commands: string[][]): string[][] {
  return commands.filter(args => {
    const at = args.indexOf("device");
    return at !== -1 && args[at + 1] === "remove";
  });
}

test("a GPU allocation attaches the device by index", async () => {
  const commands: string[][] = [];
  await agentWith(commands).execute(gpuAllocation());
  const attach = deviceAdds(commands).find(args => args.includes("gpu"));
  assert.ok(attach, "a gpu device must be added");
  assert.ok(attach!.includes("id=0"), "the device is attached by GPU index");
  // deviceName() strips dashes from the UUID and prefixes "gpu", keeping case:
  // GPU-abc123def456 becomes gpuGPUabc123def.
  assert.ok(
    attach!.includes("gpuGPUabc123def"),
    `the device has a GPU-derived name, got ${JSON.stringify(attach)}`
  );
});

test("mps mode mounts the MPS pipe directory and names it in the environment", async () => {
  const commands: string[][] = [];
  await agentWith(commands).execute(gpuAllocation({ mode: "mps" }));
  // MPS clients find the control daemon through this directory; without the
  // mount and the variable, a second container starts its own context instead
  // of sharing one.
  const mount = deviceAdds(commands).find(args => args.includes("disk"));
  assert.ok(mount, "the MPS pipe directory is mounted into the container");
  assert.ok(mount!.includes("source=/tmp/nvidia-mps"));
  assert.ok(mount!.includes("path=/tmp/nvidia-mps"));
  const execution = workloadExec(commands);
  assert.ok(execution.some(a => a === "CUDA_MPS_PIPE_DIRECTORY=/tmp/nvidia-mps"));
  assert.ok(execution.some(a => a === "CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=40"));
});

test("time-slice and dedicated modes do not mount MPS state", async () => {
  for (const mode of ["time-slice", "dedicated"] as const) {
    const commands: string[][] = [];
    await agentWith(commands).execute(gpuAllocation({ mode }));
    assert.equal(
      commands.some(args => args.some(a => a.includes("nvidia-mps"))),
      false,
      `${mode} must not mount the MPS pipe directory`
    );
    const execution = workloadExec(commands);
    assert.equal(
      execution.some(a => a.startsWith("CUDA_MPS_")),
      false,
      `${mode} must not set MPS variables`
    );
  }
});

test("mig mode refuses rather than silently running unpartitioned", async () => {
  const commands: string[][] = [];
  await assert.rejects(
    agentWith(commands).execute(gpuAllocation({ mode: "mig" })),
    /MIG allocation requires a pre-provisioned MIG partition/
  );
  assert.equal(commands.length, 0, "nothing is attached when MIG is refused");
});

test("release detaches every device it attached, including the MPS mount", async () => {
  const commands: string[][] = [];
  await agentWith(commands).release(gpuAllocation({ mode: "mps" }));
  const removals = deviceRemoves(commands);
  assert.equal(removals.length, 2, "both the gpu and the MPS pipe device are removed");
  // A leftover gpu device on the container would make the next allocation fail.
  assert.ok(removals.some(args => args.includes("gpuGPUabc123def")));
  assert.ok(removals.some(args => args.includes("mps-pipe-GPUabc123def")));
});

test("a non-mps release removes only the gpu device", async () => {
  const commands: string[][] = [];
  await agentWith(commands).release(gpuAllocation({ mode: "time-slice" }));
  const removals = deviceRemoves(commands);
  assert.equal(removals.length, 1, "no MPS device was attached, so none is removed");
});

// ── 2. nvidia.runtime is not a live-updatable option ─────────────────────

function restarts(commands: string[][]): string[][] {
  return commands.filter(args => args[1] === "restart");
}

test("a container that has never had the runtime is restarted so the libraries mount", async () => {
  const commands: string[][] = [];
  await agentWith(commands).execute(gpuAllocation());
  // Incus marks nvidia.runtime "Live update: no", so setting it on a running
  // container leaves the device attached with no userspace libraries — the
  // exact driver/library mismatch the option exists to prevent.
  assert.equal(restarts(commands).length, 1, "the runtime must be applied by a restart");
  // One start must apply both the libraries and the device, so the device is
  // added first and the restart is the last step before the workload.
  assert.ok(
    indexOfCommand(commands, a => a.includes("nvidia.runtime=true")) <
    indexOfCommand(commands, a => a[1] === "restart"),
    "the option is set before the restart that applies it"
  );
  assert.ok(
    indexOfCommand(commands, a => a.includes("gpu") && a[1] === "config") <
    indexOfCommand(commands, a => a[1] === "restart"),
    "the device is attached before the restart, so the guest sees it on boot"
  );
  assert.ok(
    indexOfCommand(commands, a => a[1] === "restart") <
    indexOfCommand(commands, a => a.some(v => v.includes("cudaMemset"))),
    "the restart happens before the workload, not after it"
  );
});

test("a container that already had the runtime is not restarted again", async () => {
  const commands: string[][] = [];
  await agentWith(commands, true).execute(gpuAllocation());
  // The common case, and the one that must not interrupt an open desktop
  // session: the option is left set, so only the first allocation pays.
  assert.equal(restarts(commands).length, 0, "no needless restart");
  assert.ok(commands.some(args => args.includes("nvidia.runtime=true")), "still idempotent");
});

test("releasing an allocation removes the device without restarting the container", async () => {
  const commands: string[][] = [];
  await agentWith(commands).release(gpuAllocation());
  assert.equal(restarts(commands).length, 0, "release never restarts the guest");
});

test("a guest without the CUDA runtime is refused before the workload runs", async () => {
  const commands: string[][] = [];
  const agent = new NvidiaWorkerAgent(async args => {
    commands.push([...args]);
    if (args[1] === "config" && args[2] === "get") return "true";
    if (args.includes("--query-gpu=mig.mode.current")) return "Disabled";
    if (args[0] === "nvidia-smi" && String(args[1]).startsWith("--query-gpu=")) {
      return "GPU-abc123def456, 0, NVIDIA T4, 16384, 0, 0, 40";
    }
    // The CUDA preflight fails: python3 cannot load the runtime.
    if (args[1] === "exec" && args.some(a => a.includes("cudaMalloc"))) {
      throw new Error("ModuleNotFoundError: libcudart.so.12");
    }
    return "";
  });
  // A device attached to a guest with no runtime produces an opaque CUDA error
  // in the middle of a paid hour; this makes it a named provisioning gap.
  await assert.rejects(
    agent.execute(gpuAllocation()),
    /cannot run CUDA.*installCudaRuntime/s
  );
  assert.equal(
    commands.some(args => args.some(a => a.includes("cudaMemset"))),
    false,
    "the workload must not start when the runtime is missing"
  );
});

// ── 3. Architecture assumptions ──────────────────────────────────────────

test("libatomic is requested only where Node actually needs it", () => {
  // The live arm64 blocker: node installs but cannot exec without libatomic.so.1.
  assert.ok(nodeRuntimePackages("linux-arm64").includes("libatomic1"));
  // x86_64 links no separate libatomic, so requesting it is a needless
  // dependency on an archive that may not carry the package.
  assert.equal(nodeRuntimePackages("linux-x64").includes("libatomic1"), false);
  assert.ok(nodeRuntimePackages("linux-x64").includes("ca-certificates"));
});

test("the x86_64 install script is a first-class path, not an arm64 copy", () => {
  const script = nodeInstallScript("v26.13.0", "linux-x64");
  assert.match(script, /node-v26\.13\.0-linux-x64\.tar\.xz/);
  assert.match(script, /SHASUMS256\.txt/);
  assert.doesNotMatch(script, /libatomic1/);
  // The same three checks that gate the arm64 path must gate this one.
  assert.match(script, /sha256sum -c expected\.txt/);
  assert.match(script, /\/usr\/local\/bin\/node --version/);
});

test("the apt date override applies only to a genuinely skewed clock", () => {
  const now = 1_700_000_000;
  // A cloud image syncing over NTP drifts by seconds at most.
  assert.equal(clockNeedsAptOverride(now, now), false);
  assert.equal(clockNeedsAptOverride(now + 120, now), false, "2 minutes is ordinary skew");
  // The observed worker was roughly two days ahead of the repositories.
  assert.equal(clockNeedsAptOverride(now + 2 * 86_400, now), true);
  assert.equal(clockNeedsAptOverride(now - 2 * 86_400, now), true);
  // An unreadable clock must not enable a security relaxation.
  assert.equal(clockNeedsAptOverride(Number.NaN, now), false);
});

// ── 5. Forking a computer ────────────────────────────────────────────────

function forkableDriver(overrides: Partial<WorkerDriver> = {}): WorkerDriver {
  return {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() {},
    async execute() { return ""; },
    async fork() {},
    ...overrides
  };
}

function serviceWith(path: string, driver: WorkerDriver) {
  return new CloudComputerService({
    store: new CloudComputerStore(path),
    driver,
    workerHost: "gokul@worker"
  });
}

function database(): string {
  return join(mkdtempSync(join(tmpdir(), "syntrum-pregpu-")), "cloud.sqlite");
}

test("forking branches a stopped computer and starts the copy", async t => {
  const path = database();
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  const service = serviceWith(path, { ...forkableDriver(), fork: (a, b) => driver.fork(a, b) });
  t.after(() => { service.close(); rmSync(path, { recursive: true, force: true }); });

  const source = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false });
  await service.stop(source.id);
  const fork = await service.fork(source.id, {}, OPERATOR);

  assert.equal(fork.status, "running");
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.cpu, source.cpu, "sizing defaults to the source");
  assert.ok(fork.desktopPort !== source.desktopPort, "the fork gets its own desktop port");
  // IncusWorkerDriver prefixes every argv with "incus".
  const copy = calls.find(args => args[1] === "copy");
  assert.ok(copy, "incus copy runs");
  assert.equal(copy![2], source.id, "the source is the copy origin");
  assert.equal(copy![3], fork.id, "the fork id is the copy target");
  assert.ok(
    calls.some(args => args[1] === "start" && args[2] === fork.id),
    "the copy is started"
  );
  // Two computers now exist; the source was not replaced.
  assert.equal(service.list().length, 2);
});

test("a running computer is refused as a fork source", async t => {
  const path = database();
  const service = serviceWith(path, forkableDriver());
  t.after(() => { service.close(); rmSync(path, { recursive: true, force: true }); });

  const source = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false });
  await assert.rejects(
    service.fork(source.id, {}, OPERATOR),
    (error: any) => error.code === "SOURCE_NOT_STOPPED"
  );
});

test("a worker without fork support reports it rather than failing obscurely", async t => {
  const path = database();
  const service = serviceWith(path, {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() {},
    async execute() { return ""; }
  });
  t.after(() => { service.close(); rmSync(path, { recursive: true, force: true }); });

  const source = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false });
  await service.stop(source.id);
  await assert.rejects(
    service.fork(source.id, {}, OPERATOR),
    (error: any) => error.code === "FORK_NOT_SUPPORTED" && error.statusCode === 501
  );
});

test("a fork inherits the owner and spends the owner's quota", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path, forkableDriver());
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a", 2);
  const b = accounts.create("team-b");
  const callerA: Caller = { kind: "account", account: a.account };
  const callerB: Caller = { kind: "account", account: b.account };

  const source = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false }, callerA);
  await service.stop(source.id, callerA);

  const fork = await service.fork(source.id, {}, callerA);
  assert.equal(fork.ownerId, a.account.id, "the fork belongs to the source's owner");

  // The fork counted against the limit of two, so a third is refused.
  await assert.rejects(
    service.create({ desktopEnabled: false }, callerA),
    (error: any) => error.code === "COMPUTER_LIMIT_REACHED"
  );

  // A different account cannot even see the source, let alone fork it.
  await assert.rejects(
    service.fork(source.id, {}, callerB),
    (error: any) => error.code === "COMPUTER_NOT_FOUND"
  );
});

// ── 4. The bootstrap script ──────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the worker bootstrap script parses and carries no embedded secrets", async () => {
  const scriptPath = resolve(repoRoot, "scripts/bootstrap-worker.sh");
  const source = readFileSync(scriptPath, "utf8");

  // A shell syntax error on a rented box costs rental time to diagnose.
  await run("bash", ["-n", scriptPath]);

  // Secrets must come from the environment; a token committed into a script
  // that is copied onto a third-party machine leaks it.
  assert.doesNotMatch(source, /SYNTRUM_OPERATOR_TOKEN="[^"$]/);
  assert.doesNotMatch(source, /Bearer [A-Za-z0-9_-]{20,}/);
  assert.match(source, /SYNTRUM_OPERATOR_TOKEN="\$\{SYNTRUM_OPERATOR_TOKEN:-\}"/);
});

test("the bootstrap script sets up everything a GPU worker needs", () => {
  const source = readFileSync(resolve(repoRoot, "scripts/bootstrap-worker.sh"), "utf8");
  for (const [need, pattern] of [
    ["the Zabbly Incus repository", /pkgs\.zabbly\.com/],
    ["Incus initialisation", /incus admin init --auto/],
    ["the NVIDIA container toolkit", /nvidia-container-toolkit/],
    ["the operator account", /useradd/],
    ["a place for the operator's key", /authorized_keys/]
  ] as const) {
    assert.match(source, pattern, `the script must handle ${need}`);
  }
  // Idempotence: every install step must be guarded, or a re-run after a
  // partial failure starts the clock over.
  assert.match(source, /command -v incus/);
  assert.match(source, /dpkg -s nvidia-container-toolkit/);
});
