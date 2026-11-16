import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
  parseWorkerTargets,
  type CommandRunner,
  type ComputerSpec,
  type WorkerDriver
} from "../src/cloud/index.js";

const spec: ComputerSpec = {
  id: "computer-1",
  workerHost: "gokul@worker",
  image: "images:ubuntu/24.04",
  cpu: 1,
  memoryMb: 1024,
  diskGb: 5,
  storageVolume: "syntrum-workspace-computer-1",
  desktopPort: 20000,
  desktopEnabled: false
};

function runner(
  calls: string[][],
  fail?: (args: string[]) => void
): CommandRunner {
  return async args => {
    calls.push([...args]);
    fail?.(args);
    return "";
  };
}

async function expectCloudCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    assert.fail(`Expected ${code}`);
  } catch (error: any) {
    const message = error?.message;
    assert.equal(error?.code, code, message);
  }
}

test("headless instance has root override and independent workspace", async () => {
  const calls: string[][] = [];
  await new IncusWorkerDriver(runner(calls)).create(spec);
  assert.ok(calls.some(args =>
    args[1] === "config" && args[2] === "device" && args[3] === "override" &&
    args.includes("pool=default") && args.includes("path=/")));
  assert.ok(calls.some(args =>
    args.join(" ") === "incus storage volume create default syntrum-workspace-computer-1 size=5GiB"));
  assert.ok(calls.some(args => args.includes("path=/workspace")));
  assert.equal(calls.some(args => args.includes("cloud-init.user-data")), false);
});

// Without pool=, Incus reads source= as a host filesystem path, which the
// restricted project rejects via restricted.devices.disk.paths.
test("workspace disk names its storage pool", async () => {
  const calls: string[][] = [];
  await new IncusWorkerDriver(runner(calls)).create(spec);
  const workspace = calls.find(args => args.includes("path=/workspace"));
  assert.ok(workspace, "workspace device must be added");
  assert.ok(workspace.includes("pool=default"), `missing pool= in: ${workspace.join(" ")}`);
  assert.ok(workspace.includes("source=syntrum-workspace-computer-1"));
});

test("delete propagates volume failure while accepting confirmed missing container", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(runner(calls, args => {
    if (args[1] === "delete") throw new Error("Instance not found");
    if (args[1] === "storage") throw new Error("storage busy");
  }));
  await assert.rejects(driver.destroy(spec), /Workspace delete: storage busy/);
  // The container is confirmed gone, the bus device is dropped, and the volume
  // is attempted — a missing container must not skip the rest of the cleanup.
  assert.ok(calls.some(args => args[1] === "delete"));
  assert.ok(calls.some(args => args[1] === "storage" && args[2] === "volume"));
});

test("failures in both deletion steps are aggregated", async () => {
  const driver = new IncusWorkerDriver(async () => { throw new Error("network unavailable"); });
  await assert.rejects(driver.destroy(spec), /Container delete: network unavailable/);
  await assert.rejects(driver.destroy(spec), /Workspace delete: network unavailable/);
});

test("create cleanup only touches new target and reports all errors", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(runner(calls, args => {
    if (args[1] === "create") throw new Error("image denied");
    if (args[1] === "delete") throw new Error("network down");
    if (args[1] === "storage") throw new Error("volume denied");
  }));
  await assert.rejects(driver.create(spec), /image denied.*Cleanup failed.*network down.*volume denied/s);
  assert.equal(calls[1][2], spec.id);
  // Cleanup must name only this computer: never a pre-existing instance.
  for (const call of calls) {
    assert.equal(
      call.includes("syntrum-test"),
      false,
      `cleanup touched a pre-existing instance: ${call.join(" ")}`
    );
  }
  assert.ok(calls.some(args => args[1] === "delete" && args[2] === spec.id));
  assert.ok(calls.some(args => args[1] === "storage" && args[2] === "volume"));
});

test("failed delete persists error and option remains persisted", async t => {
  const driver: WorkerDriver = {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() { throw new Error("volume busy"); },
    async execute() { return ""; }
  };
  const store = new CloudComputerStore(":memory:");
  const service = new CloudComputerService({ store, driver, workerHost: "gokul@worker" });
  t.after(() => service.close());
  const computer = await service.create({ desktopEnabled: false });
  assert.equal(computer.desktopEnabled, false);
  assert.throws(() => service.access(computer.id), /no desktop/);
  await assert.rejects(service.destroy(computer.id), /volume busy/);
  assert.equal(service.get(computer.id).status, "error");
  assert.throws(() => service.execute(computer.id, ["uname"]), (error: any) => {
    assert.equal(error.code, "COMPUTER_NOT_RUNNING");
    return true;
  });
  driver.destroy = async () => {};
  await service.destroy(computer.id);
  await assert.rejects(service.start(computer.id), (error: any) => {
    assert.equal(error.code, "COMPUTER_DELETED");
    return true;
  });
  assert.throws(() => service.execute(computer.id, ["uname"]), error => {
    assert.equal(error.code, "COMPUTER_DELETED");
    return true;
  });
});

// ── Multiple workers ─────────────────────────────────────────────────────

/** Records which worker each lifecycle call landed on. */
function recordingDriver(worker: string, calls: string[]): WorkerDriver {
  const record = (operation: string) => { calls.push(`${worker}:${operation}`); };
  return {
    async create(spec) { record(`create:${spec.workerHost}`); },
    async start() { record("start"); },
    async stop() { record("stop"); },
    async restart() { record("restart"); },
    async inspect() { record("inspect"); return "running"; },
    async destroy() { record("destroy"); },
    async execute() { record("execute"); return ""; },
    async fork() { record("fork"); }
  };
}

function multiWorkerService(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "syntrum-multiworker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const databasePath = join(directory, "cloud.sqlite");
  const store = new CloudComputerStore(databasePath);
  const service = new CloudComputerService({
    store,
    workerHost: "gokul@arm",
    driver: recordingDriver("gokul@arm", calls),
    drivers: new Map([
      ["gokul@arm", recordingDriver("gokul@arm", calls)],
      ["gokul@gpu", recordingDriver("gokul@gpu", calls)]
    ])
  });
  t.after(() => service.close());
  return { service, calls, databasePath };
}

test("a computer created on a named worker is driven by that worker", async t => {
  const { service, calls } = multiWorkerService(t);
  const computer = await service.create({ desktopEnabled: false, workerHost: "gokul@gpu" });
  assert.equal(computer.workerHost, "gokul@gpu", "the row records the chosen worker");
  assert.ok(calls.includes("gokul@gpu:create:gokul@gpu"), `landed on: ${calls.join(", ")}`);

  // Every later operation must resolve to the same worker, not the default.
  await service.stop(computer.id);
  await service.destroy(computer.id);
  assert.ok(calls.includes("gokul@gpu:stop"));
  assert.ok(calls.includes("gokul@gpu:destroy"));
  assert.equal(calls.some(call => call.startsWith("gokul@arm:stop")), false);
});

test("access reports the computer's own worker, not the default", async t => {
  const { service } = multiWorkerService(t);
  const computer = await service.create({ workerHost: "gokul@gpu" });
  assert.match(service.access(computer.id).sshTunnelCommand, /gokul@gpu/);
  assert.equal(service.agentAccess(computer.id).workerHost, "gokul@gpu");
});

test("an unknown worker is refused before any row or container exists", async t => {
  const { service, calls } = multiWorkerService(t);
  await expectCloudCode(
    service.create({ desktopEnabled: false, workerHost: "someone@elsewhere" }),
    "WORKER_NOT_REGISTERED"
  );
  assert.equal(service.list().length, 0, "nothing is recorded for a refused worker");
  assert.equal(calls.length, 0, "no driver was ever reached");
});

test("a fork stays on its source's worker even if another exists", async t => {
  const { service, calls } = multiWorkerService(t);
  const source = await service.create({ desktopEnabled: false, workerHost: "gokul@gpu" });
  await service.stop(source.id);
  const fork = await service.fork(source.id);
  assert.equal(fork.workerHost, "gokul@gpu");
  assert.ok(calls.includes("gokul@gpu:fork"));
});

test("a computer on a worker with no driver is reported, not run elsewhere", async t => {
  const { service, databasePath } = multiWorkerService(t);
  const computer = await service.create({ desktopEnabled: false, workerHost: "gokul@gpu" });
  // Simulate the row outliving its worker's registration (e.g. SYNTRUM_WORKERS
  // was edited). Serving it on the default worker would be a wrong-host
  // operation, so it must fail instead.
  const lonely = new CloudComputerService({
    store: new CloudComputerStore(databasePath),
    workerHost: "gokul@arm",
    driver: recordingDriver("gokul@arm", []),
    drivers: new Map([["gokul@arm", recordingDriver("gokul@arm", [])]])
  });
  t.after(() => lonely.close());
  await expectCloudCode(lonely.stop(computer.id), "WORKER_OPERATION_FAILED");
});

test("SYNTRUM_WORKERS parses a list, falls back to one worker, and rejects duplicates", () => {
  assert.deepEqual(
    parseWorkerTargets({ SYNTRUM_WORKERS: "gokul@arm, gokul@gpu" }),
    [{ user: "gokul", host: "arm" }, { user: "gokul", host: "gpu" }]
  );
  assert.deepEqual(
    parseWorkerTargets({ SYNTRUM_WORKER_SSH_USER: "gokul", SYNTRUM_WORKER_SSH_HOST: "worker.example" }),
    [{ user: "gokul", host: "worker.example" }]
  );
  // One machine's computers routing to another's driver is refused outright.
  assert.throws(
    () => parseWorkerTargets({ SYNTRUM_WORKERS: "gokul@arm,gokul@arm" }),
    /more than once/
  );
  assert.throws(() => parseWorkerTargets({ SYNTRUM_WORKERS: "not-a-host" }), /user@host/);
});
