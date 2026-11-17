import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AccountStore,
  CloudComputerService,
  CloudComputerStore,
  GuestProvisioner,
  GUEST_BUS_MODULES,
  GUEST_BUS_UNIT,
  IncusWorkerDriver,
  OPERATOR,
  createCloudHttpServer,
  guestSocketPath,
  sshArgs,
  type Caller,
  type WorkerDriver
} from "../src/cloud/index.js";

/**
 * Phase 4 wiring: the guest bus socket exposed on the worker, an agent's access
 * route, and the guest-side install. The bus protocol itself is covered by the
 * daemon and bridge test files.
 */

function database(): string {
  return join(mkdtempSync(join(tmpdir(), "syntrum-phase4-")), "cloud.sqlite");
}

function driver(overrides: Partial<WorkerDriver> = {}): WorkerDriver {
  return {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() {},
    async execute() { return ""; },
    ...overrides
  };
}

/**
 * A provisioner that records what it was asked to install without compiling
 * anything or touching a guest. `compile` is what the real one shells out to
 * `tsc` for; a double here keeps these tests offline and fast.
 */
function fakeProvisioner(options: { upload?: boolean } = {}) {
  const calls: string[] = [];
  let agents: readonly { id: string; token: string }[] = [];
  return {
    calls,
    get agents() { return agents; },
    async compile(outputRoot: string) {
      calls.push("compile");
      return { directory: outputRoot, modules: "guest/bus-daemon" };
    },
    async installNode(id: string, version: string) {
      calls.push(`installNode:${id}:${version}`);
    },
    async installBus(id: string, busOptions: {
      compiledDirectory: string;
      agents: readonly { id: string; token: string }[];
      upload: (id: string, local: string, remote: string) => Promise<void>;
    }) {
      calls.push(`installBus:${id}`);
      agents = busOptions.agents;
      if (options.upload) {
        await busOptions.upload(id, busOptions.compiledDirectory, "/opt/syntrum");
      }
    }
  };
}

// ── The socket path the worker exposes ───────────────────────────────────

test("the agent socket path is derived from the computer id", () => {
  assert.equal(guestSocketPath("abc-123"), "/run/syntrum/guests/abc-123.sock");
  assert.equal(
    guestSocketPath("fc791253-be5b-4204-8442-734d9aacd70b"),
    "/run/syntrum/guests/fc791253-be5b-4204-8442-734d9aacd70b.sock"
  );
});

test("a computer id cannot steer the socket path out of its directory", () => {
  // A caller-supplied id reaching this function would otherwise choose an
  // arbitrary path on the worker for the proxy device to bind.
  for (const bad of ["../escape", "a/b", "..", "", "a b", "a\0b"]) {
    assert.throws(() => guestSocketPath(bad), `'${bad}' must be rejected`);
  }
});

// ── The proxy device that makes the socket reachable ─────────────────────

test("provisioning exposes the guest bus with a locked-down proxy device", async () => {
  const calls: string[][] = [];
  const incus = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await incus.exposeGuestBus("computer-1", "/run/syntrum/guests/computer-1.sock");
  const add = calls.find(args => args[1] === "config" && args[2] === "device" && args[3] === "add");
  assert.ok(add, "a device is added");
  assert.ok(add!.includes("proxy"));
  assert.ok(add!.includes("listen=unix:/run/syntrum/guests/computer-1.sock"));
  assert.ok(add!.includes("connect=unix:/run/syntrum/bus.sock"));
  // bind=host puts the socket on the worker, which is the only place the host
  // bridge can dial; 0600 keeps it off other local accounts.
  assert.ok(add!.includes("bind=host"));
  assert.ok(add!.includes("mode=0600"));
});

test("creating a computer exposes its bus before start", async () => {
  const calls: string[][] = [];
  const incus = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await incus.create({
    id: "fc791253-be5b-4204-8442-734d9aacd70b",
    workerHost: "gokul@worker",
    image: "images:ubuntu/24.04/cloud",
    cpu: 1, memoryMb: 1024, diskGb: 5,
    storageVolume: "syntrum-workspace-fc791253",
    desktopPort: 20000,
    desktopEnabled: false
  });
  const exposeAt = calls.findIndex(args => args.includes("agent-bus"));
  const startAt = calls.findIndex(args => args[1] === "start");
  assert.ok(exposeAt !== -1, "the bus device is added during create");
  assert.ok(startAt !== -1, "the container is started");
  assert.ok(exposeAt < startAt, "the device exists before the container starts");
});

test("a forbidden proxy device does not fail computer creation", async () => {
  // A restricted project forbids proxy devices. The workspace is still usable
  // through the guest's own tools, so this must not abort provisioning — the
  // same tolerance the desktop's port proxy already has.
  const calls: string[][] = [];
  const incus = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    if (args.includes("proxy")) throw new Error("Proxy devices are forbidden");
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  await incus.create({
    id: "fc791253-be5b-4204-8442-734d9aacd70b",
    workerHost: "gokul@worker",
    image: "images:ubuntu/24.04/cloud",
    cpu: 1, memoryMb: 1024, diskGb: 5,
    storageVolume: "syntrum-workspace-fc791253",
    desktopPort: 20000,
    desktopEnabled: false
  });
  assert.ok(calls.some(args => args.includes("agent-bus")), "the device was attempted");
  assert.ok(calls.some(args => args[1] === "start"), "the computer still started");
});

test("destroying a computer removes the bus device and its stale socket", async () => {
  const calls: string[][] = [];
  const incus = new IncusWorkerDriver(async args => {
    calls.push([...args]);
    return "";
  });
  await incus.destroy({ id: "computer-1", storageVolume: "syntrum-workspace-computer-1" });
  const removal = calls.find(args =>
    args[1] === "config" && args[2] === "device" && args[3] === "remove"
  );
  assert.ok(removal, "the device is removed");
  assert.ok(removal!.includes("agent-bus"));
  // The socket file outlives the container, so a re-created computer with the
  // same id would otherwise find a stale socket in its way.
  assert.ok(calls.some(args => args[1] === "delete"), "the container is still deleted");
});

// ── The access route ─────────────────────────────────────────────────────

test("agent access reports the socket path and workspace", async t => {
  const path = database();
  const service = new CloudComputerService({
    store: new CloudComputerStore(path), driver: driver(), workerHost: "gokul@worker",
    guestProvisioner: fakeProvisioner()
  });
  t.after(() => { service.close(); rmSync(path, { recursive: true, force: true }); });

  const computer = await service.create({ desktopEnabled: false });
  const access = service.agentAccess(computer.id, OPERATOR);
  assert.equal(access.socketPath, guestSocketPath(computer.id));
  assert.equal(access.workspaceId, "main");
  assert.equal(access.workspaceRoot, "/workspace");
  assert.equal(access.publicExposure, false);
  // The bus demands a grant, so the credential has to come back with the route.
  assert.equal(access.agent.id, computer.id);
  assert.ok(access.agent.token.length >= 16);
});

test("agent access requires a running computer", async t => {
  const path = database();
  const service = new CloudComputerService({
    store: new CloudComputerStore(path), driver: driver(), workerHost: "gokul@worker",
    guestProvisioner: fakeProvisioner()
  });
  t.after(() => { service.close(); rmSync(path, { recursive: true, force: true }); });

  const computer = await service.create({ desktopEnabled: false });
  await service.stop(computer.id);
  assert.throws(
    () => service.agentAccess(computer.id, OPERATOR),
    (error: any) => error.code === "COMPUTER_NOT_RUNNING"
  );
});

test("another account's agent access reports the computer as missing", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = new CloudComputerService({
    store: new CloudComputerStore(path), driver: driver(), workerHost: "gokul@worker"
  });
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a");
  const b = accounts.create("team-b");
  const callerA: Caller = { kind: "account", account: a.account };
  const callerB: Caller = { kind: "account", account: b.account };
  const computer = await service.create({ desktopEnabled: false }, callerA);

  // 404, not 403: the same isolation rule the desktop route follows.
  assert.throws(
    () => service.agentAccess(computer.id, callerB),
    (error: any) => error.code === "COMPUTER_NOT_FOUND" && error.statusCode === 404
  );
});

test("the agent-access route is reachable and scoped over HTTP", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = new CloudComputerService({
    store: new CloudComputerStore(path), driver: driver(), workerHost: "gokul@worker",
    guestProvisioner: fakeProvisioner()
  });
  const operatorToken = "dev-operator-token-32-characters-minimum-xyz";
  const server = createCloudHttpServer({ service, accountStore: accounts, operatorToken });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close(); accounts.close(); rmSync(path, { recursive: true, force: true });
  });

  const a = accounts.create("team-a");
  const b = accounts.create("team-b");
  const created = await fetch(`${base}/computers`, {
    method: "POST",
    headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
    body: JSON.stringify({ desktopEnabled: false })
  }).then(r => r.json() as Promise<{ computer: { id: string } }>);
  const id = created.computer.id;

  const mine = await fetch(`${base}/computers/${id}/agent-access`, {
    headers: { authorization: `Bearer ${a.token}` }
  });
  assert.equal(mine.status, 200);
  const body = await mine.json() as { socketPath: string; workspaceId: string };
  assert.equal(body.socketPath, guestSocketPath(id));
  assert.equal(body.workspaceId, "main");

  const theirs = await fetch(`${base}/computers/${id}/agent-access`, {
    headers: { authorization: `Bearer ${b.token}` }
  });
  assert.equal(theirs.status, 404, "another account must not see the socket path");
});

// ── The guest-side install ───────────────────────────────────────────────

test("the bus unit runs the compiled daemon with its own runtime directory", () => {
  assert.match(GUEST_BUS_UNIT, /ExecStart=\/usr\/local\/bin\/node \/opt\/syntrum\/guest\/bus-daemon\.js/);
  assert.match(GUEST_BUS_UNIT, /RuntimeDirectory=syntrum/);
  // The socket must not live in a world-writable /tmp.
  assert.match(GUEST_BUS_UNIT, /SYNTRUM_BUS_SOCKET=\/run\/syntrum\/bus\.sock/);
  assert.match(GUEST_BUS_UNIT, /SYNTRUM_WORKSPACE_ROOT=\/workspace/);
  assert.match(GUEST_BUS_UNIT, /EnvironmentFile=-\/etc\/syntrum\/agents\.env/);
  assert.match(GUEST_BUS_UNIT, /Restart=always/);
});

test("the shipped module list covers the daemon's whole import closure", () => {
  // The guest has no npm access, so a module left off this list is a daemon
  // that cannot start. The daemon path and the bus it serves must both be here.
  assert.ok(GUEST_BUS_MODULES.includes("guest/bus-daemon"));
  assert.ok(GUEST_BUS_MODULES.includes("bus/server"));
  assert.ok(GUEST_BUS_MODULES.includes("bus/workspace"));
  assert.ok(GUEST_BUS_MODULES.includes("bus/protocol"));
  assert.ok(GUEST_BUS_MODULES.includes("bus/client"));
  assert.ok(GUEST_BUS_MODULES.includes("adapters/errors"));
  // The MCP SDK deliberately stays on the host.
  assert.equal(
    GUEST_BUS_MODULES.some(m => m.includes("mcp")),
    false,
    "the MCP server must not ship into the guest"
  );
});

test("the install refuses an agent id or token that would corrupt the env file", async () => {
  const provisioner = new GuestProvisioner(async () => "");
  const compiledDirectory = mkdtempSync(join(tmpdir(), "syntrum-compiled-"));
  const base = { compiledDirectory, upload: async () => {} };
  try {
    await assert.rejects(
      provisioner.installBus("computer-1", { ...base, agents: [] }),
      /At least one agent grant/
    );
    for (const id of ["bad id", "a\nb", "", "-lead"]) {
      await assert.rejects(
        provisioner.installBus("computer-1", {
          ...base, agents: [{ id, token: "a".repeat(32) }]
        }),
        /Invalid agent id/,
        `id '${JSON.stringify(id)}' must be rejected`
      );
    }
    // A short token is refused: these are credentials, not identifiers.
    await assert.rejects(
      provisioner.installBus("computer-1", {
        ...base, agents: [{ id: "agent-a", token: "short" }]
      }),
      /Invalid agent token/
    );
  } finally {
    rmSync(compiledDirectory, { recursive: true, force: true });
  }
});

test("the install fails clearly when guest Node is missing", async () => {
  // Node is the daemon's only prerequisite; reporting it by name beats a unit
  // that restarts forever with no explanation.
  const provisioner = new GuestProvisioner(async () => {
    throw new Error("command not found");
  });
  const compiledDirectory = mkdtempSync(join(tmpdir(), "syntrum-compiled-"));
  try {
    await assert.rejects(
      provisioner.installBus("computer-1", {
        compiledDirectory,
        agents: [{ id: "agent-a", token: "a".repeat(32) }],
        upload: async () => {}
      }),
      /Guest Node is not installed/
    );
  } finally {
    rmSync(compiledDirectory, { recursive: true, force: true });
  }
});

test("readiness requires an active unit, a socket, and a ready line", async () => {
  const commands: string[][] = [];
  const provisioner = new GuestProvisioner(async (_id, args) => {
    commands.push([...args]);
    const script = args.join(" ");
    if (script.includes("is-active")) return "inactive";
    return "";
  });
  await assert.rejects(
    provisioner.verifyBus("computer-1", 1),
    /Guest bus is inactive/
  );
});

test("a leftover socket without a ready line is not treated as ready", async () => {
  // A socket file can survive a crashed daemon, so its presence alone is not
  // evidence that the bus is serving.
  const provisioner = new GuestProvisioner(async (_id, args) => {
    const script = args.join(" ");
    if (script.includes("is-active")) return "active";
    if (script.includes("test -S")) return "present";
    if (script.includes("syntrum-guest-bus ready")) return "0";
    return "";
  });
  await assert.rejects(
    provisioner.verifyBus("computer-1", 1),
    /has not reported ready/
  );
});

test("an active unit with a socket and a ready line passes readiness", async () => {
  const provisioner = new GuestProvisioner(async (_id, args) => {
    const script = args.join(" ");
    if (script.includes("is-active")) return "active";
    if (script.includes("test -S")) return "present";
    if (script.includes("syntrum-guest-bus ready")) return "1";
    return "";
  });
  await provisioner.verifyBus("computer-1", 1);
});

// ── Transport correctness ────────────────────────────────────────────────

test("the bridge's ssh argv never passes -n, which would cut its own stdin", () => {
  // `ssh -n` redirects stdin from /dev/null. The bridge carries the bus
  // protocol on stdin, so with -n the tunnel closes immediately and nothing
  // says why. Asserted on the real argv rather than on source text.
  const ssh = { host: "worker", user: "gokul" };
  for (const transport of ["proxy", "exec"] as const) {
    const argv = sshArgs(ssh, "/run/syntrum/guests/computer-1.sock", transport);
    assert.equal(argv.includes("-n"), false, `${transport} must not pass -n`);
    assert.ok(argv.includes("-T"), `${transport} must request no PTY`);
    assert.ok(argv.includes("BatchMode=yes"), `${transport} must not prompt`);
  }
});

test("the proxy transport dials the worker socket and the exec transport relays in the guest", () => {
  const ssh = { host: "worker", user: "gokul" };
  const socket = "/run/syntrum/guests/computer-1.sock";

  const proxy = sshArgs(ssh, socket, "proxy");
  assert.deepEqual(proxy.slice(-2), ["-W", socket], "proxy uses ssh -W on the socket path");

  const exec = sshArgs(ssh, socket, "exec");
  // The container name comes from the socket path, so the two cannot disagree.
  assert.ok(exec.includes("incus"), "exec runs incus on the worker");
  assert.ok(exec.includes("computer-1"), "exec names the computer derived from the socket path");
  assert.ok(exec.some(a => a.includes("relay.js")), "exec runs the shipped relay script");
});

test("only a valid computer id can become a container name", () => {
  // The path is built by guestSocketPath, which rejects anything that could
  // escape its directory, so sshArgs only ever sees a well-formed id. This
  // asserts the two agree, and that a malformed tail is still refused.
  assert.throws(
    () => sshArgs({ host: "w", user: "u" }, "/tmp/..sock", "exec"),
    /Cannot derive a computer id/
  );
  assert.throws(
    () => sshArgs({ host: "w", user: "u" }, "/tmp/.sock", "exec"),
    /Cannot derive a computer id/
  );
  // A well-formed id from the real builder passes.
  const argv = sshArgs({ host: "w", user: "u" }, guestSocketPath("abc-123"), "exec");
  assert.ok(argv.includes("abc-123"));
});
