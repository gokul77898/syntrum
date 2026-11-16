import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
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
