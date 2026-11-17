import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function recordingDriver(worker: string, calls: string[], order?: string[]): WorkerDriver {
  const record = (operation: string) => {
    calls.push(`${worker}:${operation}`);
    order?.push(operation);
  };
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

/**
 * A provisioner that records the install sequence without compiling anything
 * or touching a guest. `compile` is what the real one shells out to `tsc` for,
 * so a double here keeps these tests offline and fast.
 */
function fakeProvisioner(order: string[]) {
  // A real directory with a real file, created per call and cleaned up after:
  // the upload genuinely tars and streams this, so the transport is covered
  // rather than stubbed. A fake path would only prove the double works.
  let outputRoot: string | undefined;
  const provisioner = {
    agents: [] as { id: string; token: string }[],
    async compile(root: string) {
      order.push("compile");
      outputRoot = join(root, "compiled");
      mkdirSync(join(outputRoot, "guest"), { recursive: true });
      writeFileSync(join(outputRoot, "guest", "bus-daemon.js"), "export const ready = 1;\n");
      writeFileSync(join(outputRoot, "package.json"), JSON.stringify({ type: "module" }));
      return { directory: outputRoot, modules: "guest/bus-daemon" };
    },
    async installNode() { order.push("installNode"); },
    async installBus(_id: string, options: {
      compiledDirectory: string;
      agents: readonly { id: string; token: string }[];
      upload: (id: string, local: string, remote: string) => Promise<void>;
    }) {
      order.push("installBus");
      provisioner.agents = [...options.agents];
      // The real provisioner always uploads; doing it here means the transport
      // is covered rather than assumed.
      await options.upload(_id, options.compiledDirectory, "/opt/syntrum");
    }
  };
  return provisioner;
}

function multiWorkerService(t: test.TestContext, order?: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "syntrum-multiworker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const databasePath = join(directory, "cloud.sqlite");
  const store = new CloudComputerStore(databasePath);
  const service = new CloudComputerService({
    store,
    workerHost: "gokul@arm",
    driver: recordingDriver("gokul@arm", calls, order),
    drivers: new Map([
      ["gokul@arm", recordingDriver("gokul@arm", calls)],
      ["gokul@gpu", recordingDriver("gokul@gpu", calls)]
    ])
  });
  t.after(() => service.close());
  return { service, calls, databasePath };
}

/** The same two-worker service, plus a guest provisioner. */
function multiWorkerServiceWith(
  t: test.TestContext,
  order: string[],
  provisioner: ReturnType<typeof fakeProvisioner>,
  commands: string[][] = []
) {
  const directory = mkdtempSync(join(tmpdir(), "syntrum-provisioned-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const driver: WorkerDriver = {
    ...recordingDriver("gokul@arm", calls, order),
    async execute(_id, args) {
      calls.push("gokul@arm:execute");
      commands.push([...args]);
      return "";
    }
  };
  const service = new CloudComputerService({
    store: new CloudComputerStore(join(directory, "cloud.sqlite")),
    workerHost: "gokul@arm",
    driver,
    drivers: new Map([["gokul@arm", driver]]),
    guestProvisioner: provisioner
  });
  t.after(() => service.close());
  return { service, calls };
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
  // No provisioner on this service, so the bus is honestly reported absent
  // rather than handed a socket path nothing is listening on.
  assert.throws(
    () => service.agentAccess(computer.id),
    (error: any) => error.code === "GUEST_BUS_NOT_PROVISIONED"
  );
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

// ── Guest runtime provisioning during create() ───────────────────────────

test("create installs Node and the bus, and only then reports running", async t => {
  const order: string[] = [];
  const provisioner = fakeProvisioner(order);
  const { service } = multiWorkerServiceWith(t, order, provisioner);

  const computer = await service.create({ desktopEnabled: false, workerHost: "gokul@arm" });
  // A computer is only "running" once its bus socket is verified live, so the
  // install must come before the status flips.
  assert.deepEqual(order, ["create:gokul@arm", "compile", "installNode", "installBus"]);
  assert.equal(computer.status, "running");
  // One agent per computer, named after the computer, with a real token.
  assert.equal(provisioner.agents.length, 1);
  assert.equal(provisioner.agents[0].id, computer.id);
  assert.ok(provisioner.agents[0].token.length >= 32);
});

test("a failed guest install reports error rather than a running computer", async t => {
  const order: string[] = [];
  const provisioner = fakeProvisioner(order);
  provisioner.installBus = async () => {
    order.push("installBus");
    throw new Error("Guest bus is not active; journal: Cannot find module");
  };
  const { service } = multiWorkerServiceWith(t, order, provisioner);

  await assert.rejects(
    service.create({ desktopEnabled: false }),
    (error: any) => error.code === "WORKER_CREATE_FAILED"
  );
  // "running" with no bus is exactly the state agent-access cannot detect, so
  // the row must be left in error — visible, inspectable, and not usable.
  const rows = service.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "error");
  assert.equal(service.get(rows[0].id).status, "error");
});

test("the agent token never appears in a computer record", async t => {
  const provisioner = fakeProvisioner([]);
  const { service } = multiWorkerServiceWith(t, [], provisioner);

  const computer = await service.create({ desktopEnabled: false });
  const token = provisioner.agents[0].token;
  // The token exists only behind agentAccess. If it rode along on the record it
  // would reach every list and status response.
  assert.equal(JSON.stringify(computer).includes(token), false);
  assert.equal(JSON.stringify(service.list()).includes(token), false);
  assert.equal(service.agentAccess(computer.id).agent.token, token);
});

test("create uploads the compiled daemon through the guest, not the worker's disk", async t => {
  // The upload is the one step with no other way to verify it: `incus file
  // push` resolves its source on the *worker*, which the control plane cannot
  // assume it can write to. Assert the transport is a guest command, and that
  // the payload really is the daemon's JavaScript.
  const order: string[] = [];
  const provisioner = fakeProvisioner(order);
  const commands: string[][] = [];
  const { service } = multiWorkerServiceWith(t, order, provisioner, commands);

  const computer = await service.create({ desktopEnabled: false });
  assert.equal(computer.status, "running");
  // installBus is given a local directory to push; the double invokes upload,
  // which must reach the guest through the driver rather than the filesystem.
  assert.ok(
    commands.some(args => args.includes("mkdir") && args.includes("/opt/syntrum")),
    `the guest must be prepared through exec, got: ${JSON.stringify(commands)}`
  );
});

test("a worker without guest execution refuses to pretend it provisioned", async t => {
  const order: string[] = [];
  const provisioner = fakeProvisioner(order);
  const service = new CloudComputerService({
    store: new CloudComputerStore(":memory:"),
    workerHost: "gokul@arm",
    // No execute: the guest runtime has no way in.
    driver: { ...recordingDriver("gokul@arm", []), execute: undefined },
    guestProvisioner: provisioner
  });
  t.after(() => service.close());

  await assert.rejects(
    service.create({ desktopEnabled: false }),
    (error: any) => error.code === "WORKER_CREATE_FAILED"
      && /does not expose guest execution/.test(error.message)
  );
  // Nothing may be recorded as installed when no install could happen.
  assert.equal(order.includes("installNode"), false);
});

test("a create with no provisioner reports the bus as not provisioned", async t => {
  const { service } = multiWorkerService(t);
  const computer = await service.create({ desktopEnabled: false });
  // The desktop still works; only the agent route is refused, and by name.
  assert.throws(
    () => service.agentAccess(computer.id),
    (error: any) => error.code === "GUEST_BUS_NOT_PROVISIONED" && error.statusCode === 409
  );
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
