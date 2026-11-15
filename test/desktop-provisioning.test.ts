import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
  type ComputerSpec,
  type WorkerDriver
} from "../src/cloud/index.js";

const spec: ComputerSpec = {
  id: "computer-1",
  workerHost: "gokul@worker",
  image: "images:ubuntu/24.04",
  cpu: 2,
  memoryMb: 2048,
  diskGb: 5,
  storageVolume: "syntrum-workspace-computer-1",
  desktopPort: 20000,
  desktopEnabled: true
};

function runner(
  calls: string[][],
  fail?: (args: string[]) => void
): (args: readonly string[]) => Promise<string> {
  return async args => {
    calls.push([...args]);
    fail?.(args);
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  };
}

test("a forbidden proxy device does not fail desktop creation", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(runner(calls, args => {
    if (args.includes("proxy")) throw new Error("Proxy devices are forbidden");
  }));
  await driver.create(spec);
  // The proxy is attempted, then tolerated; the instance is still started.
  assert.ok(calls.some(args => args.includes("proxy")));
  assert.ok(calls.some(args => args[1] === "start"));
});

test("a proxy failure that is not a policy denial still aborts creation", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(runner(calls, args => {
    if (args.includes("proxy")) throw new Error("Permission denied");
  }));
  await assert.rejects(driver.create(spec), /Permission denied/);
  assert.equal(calls.some(args => args[1] === "start"), false);
});

test("websockify binds the container port, not a fixed loopback port", async () => {
  const calls: string[][] = [];
  await new IncusWorkerDriver(runner(calls)).create(spec);
  const cloudInit = calls.find(args => args.includes("cloud-init.user-data"))?.at(-1) ?? "";
  assert.match(cloudInit, /websockify --web=\/usr\/share\/novnc 0\.0\.0\.0:20000/);
  // x11vnc must stay on guest loopback: only websockify is ever reachable.
  assert.match(cloudInit, /x11vnc -display :0 -rfbport 5900 -localhost/);
});

// write-files runs before users-groups. An entry owned by syntrum fails there
// and aborts every later file, so none of the four units get written and the
// runcmd then fails with "Unit file ... does not exist".
test("no write_files entry is owned by a user cloud-init has not created yet", async () => {
  const calls: string[][] = [];
  await new IncusWorkerDriver(runner(calls)).create(spec);
  const cloudInit = calls.find(args => args.includes("cloud-init.user-data"))?.at(-1) ?? "";
  const section = cloudInit.split("write_files:")[1] ?? "";
  assert.ok(section.length > 0, "write_files section is present");
  assert.doesNotMatch(section, /owner:\s*(?!root:root)\S+/, "only root-owned files are written");
});

test("the apt date override is injected only when configured", async () => {
  const without: string[][] = [];
  await new IncusWorkerDriver(runner(without)).create(spec);
  const plain = without.find(args => args.includes("cloud-init.user-data"))?.at(-1) ?? "";
  assert.equal(plain.includes("Check-Date"), false);

  const withConf: string[][] = [];
  await new IncusWorkerDriver(
    runner(withConf), undefined, undefined, "Acquire::Check-Date \"false\";"
  ).create(spec);
  const conf = withConf.find(args => args.includes("cloud-init.user-data"))?.at(-1) ?? "";
  assert.match(conf, /apt:\n {2}conf: \|/);
  assert.match(conf, /Acquire::Check-Date/);
});

test("desktop verification accepts only all-active units", async () => {
  const driver = new IncusWorkerDriver(async args => {
    if (args.includes("systemctl")) return "active\nactive\nactive\nactive\n";
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await driver.verifyDesktop(spec.id);
});

test("desktop verification names the inactive unit and does not pass", async () => {
  const driver = new IncusWorkerDriver(async args => {
    if (args.includes("systemctl")) return "active\nactivating\nactive\nfailed\n";
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await assert.rejects(
    driver.verifyDesktop(spec.id),
    /syntrum-desktop\.service, syntrum-novnc\.service/
  );
});

test("truncated unit output is treated as failure, not as success", async () => {
  const driver = new IncusWorkerDriver(async args => {
    if (args.includes("systemctl")) return "active\n";
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await assert.rejects(driver.verifyDesktop(spec.id), /Desktop services not active/);
});

test("a desktop that never came up is persisted as error, not running", async t => {
  const driver: WorkerDriver = {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() {},
    async execute() { return ""; },
    async verifyDesktop() { throw new Error("Desktop services not active: syntrum-novnc.service"); }
  };
  const store = new CloudComputerStore(":memory:");
  const service = new CloudComputerService({ store, driver, workerHost: "gokul@worker" });
  t.after(() => service.close());
  await assert.rejects(
    service.create({ desktopEnabled: true }),
    (error: any) => error.code === "WORKER_CREATE_FAILED"
  );
  const [computer] = service.list();
  assert.equal(computer.status, "error");
  assert.match(computer.error ?? "", /syntrum-novnc\.service/);
});

test("verification is skipped when no desktop was requested", async t => {
  let verified = false;
  const driver: WorkerDriver = {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() {},
    async execute() { return ""; },
    async verifyDesktop() { verified = true; }
  };
  const store = new CloudComputerStore(":memory:");
  const service = new CloudComputerService({ store, driver, workerHost: "gokul@worker" });
  t.after(() => service.close());
  const computer = await service.create({ desktopEnabled: false });
  assert.equal(computer.status, "running");
  assert.equal(verified, false);
});
