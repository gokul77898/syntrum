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

// The probe is one shell string whose exit code is the bare status command's:
// "done" exits 0, "error" does not. The swallowed --wait exit code is what
// used to abort a healthy build.
test("a non-zero cloud-init --wait exit that reports done does not fail creation", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    if (args.some(a => a.includes("cloud-init status"))) return "status: done\n";
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await driver.create(spec);
  assert.ok(calls.some(args => args[1] === "start"));
});

test("cloud-init reporting error status still aborts creation", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    if (args.some(a => a.includes("cloud-init status"))) {
      // A real error makes the bare status command exit non-zero.
      throw new Error("status: error");
    }
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await assert.rejects(driver.create(spec), /status: error/);
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

// systemctl is-active exits 4 when any unit is inactive, and the runner treats
// a non-zero exit as a failure. Without `|| true` the probe throws the raw
// runner message and the per-unit diagnosis below it is unreachable — which is
// how a live run reported bare "inactive" four times instead of naming a unit.
test("the is-active probe masks a non-zero exit so states stay readable", async () => {
  const calls: string[][] = [];
  const driver = new IncusWorkerDriver(runner(calls));
  await driver.verifyDesktop(spec.id).catch(() => {});
  const probe = calls.find(args => args.some(a => a.includes("systemctl is-active")));
  assert.ok(probe, "the probe runs");
  const script = probe.find(a => a.includes("systemctl is-active")) ?? "";
  assert.match(script, /\|\|\s*true$/, "inactive units must not surface as a command failure");
});

test("desktop verification accepts only all-active units", async () => {
  const driver = new IncusWorkerDriver(async args => {
    if (args.some(a => a.includes("systemctl is-active"))) return "active\nactive\nactive\nactive\n";
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await driver.verifyDesktop(spec.id);
});

test("desktop verification names the inactive unit and does not pass", async () => {
  const driver = new IncusWorkerDriver(async args => {
    if (args.some(a => a.includes("systemctl is-active"))) return "active\nactivating\nactive\nfailed\n";
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await assert.rejects(
    driver.verifyDesktop(spec.id),
    /syntrum-desktop\.service, syntrum-novnc\.service/
  );
});

test("truncated unit output is treated as failure, not as success", async () => {
  const driver = new IncusWorkerDriver(async args => {
    if (args.some(a => a.includes("systemctl is-active"))) return "active\n";
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
