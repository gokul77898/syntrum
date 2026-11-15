import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RuntimeError,
  RuntimeSupervisor,
  silentLogger,
  type NativeManager,
  type NativeResult
} from "../src/runtime/index.js";

class FakeNativeManager implements NativeManager {
  readonly launchCalls: string[] = [];
  readonly inspectCalls: { pid: number; bundleIdentifier: string }[] = [];
  readonly terminateCalls: { pid: number; bundleIdentifier: string }[] = [];
  readonly launchResults: NativeResult[] = [];
  readonly inspectResults: NativeResult[] = [];
  readonly terminateResults: NativeResult[] = [];
  private readonly launchDates = new Map<number, string>();

  async launch(bundleIdentifier: string): Promise<NativeResult> {
    this.launchCalls.push(bundleIdentifier);
    const pid = 1000 + this.launchCalls.length;
    const configured = this.launchResults.shift();
    const resultPid = configured?.pid ?? pid;
    const launchDate = configured?.launchDate ??
      this.launchDates.get(resultPid) ??
      new Date(Date.UTC(2026, 0, 1, 0, 0, resultPid)).toISOString();
    if (configured?.pid !== undefined && configured.launchDate === undefined) {
      configured.launchDate = launchDate;
    }
    this.launchDates.set(resultPid, launchDate);
    return configured ?? {
      ok: true,
      pid,
      name: "Example",
      bundleIdentifier,
      bundleURL: "/Applications/Example.app",
      launchDate,
      preExisting: false
    };
  }

  async inspect(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    this.inspectCalls.push({ pid, bundleIdentifier });
    return this.inspectResults.shift() ?? {
      ok: true,
      pid,
      bundleIdentifier,
      launchDate: this.launchDates.get(pid),
      running: true
    };
  }

  async terminate(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    this.terminateCalls.push({ pid, bundleIdentifier });
    return this.terminateResults.shift() ?? {
      ok: true,
      pid,
      running: false,
      terminationRequested: true
    };
  }

  async frontmost(): Promise<NativeResult> {
    return { ok: true, available: true, pid: 1, bundleIdentifier: "com.example.Frontmost" };
  }
}

function memorySupervisor(nativeManager: FakeNativeManager, pollIntervalMs = 0): RuntimeSupervisor {
  return new RuntimeSupervisor({
    databasePath: ":memory:",
    nativeManager,
    logger: silentLogger,
    pollIntervalMs
  });
}

async function expectRuntimeError(
  operation: Promise<unknown>,
  statusCode: number,
  code: string
): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test("SQLite migrations preserve sessions, stable application IDs, and events across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-ai-os-runtime-"));
  const databasePath = join(directory, "runtime.sqlite");
  const native = new FakeNativeManager();
  const first = new RuntimeSupervisor({
    databasePath,
    nativeManager: native,
    logger: silentLogger,
    pollIntervalMs: 0
  });

  try {
    const session = first.createSession();
    const launched = await first.launchApplication(session.id, "com.example.Persistent");
    assert.match(launched.application.id, /^[0-9a-f-]{36}$/);
    assert.equal(launched.application.processOrigin, "launched");
    assert.equal(launched.application.processIdentity, "verified");
    assert.equal(first.listEvents(session.id).length, 2);
    const applicationId = launched.application.id;
    await first.close();

    const restarted = new RuntimeSupervisor({
      databasePath,
      nativeManager: native,
      logger: silentLogger,
      pollIntervalMs: 0
    });
    try {
      await restarted.start();
      const restored = await restarted.getApplication(session.id, applicationId, false);
      assert.equal(restored.id, applicationId);
      assert.equal(restored.bundleIdentifier, "com.example.Persistent");
      assert.equal(restarted.getSession(session.id).applications.length, 1);
      const events = restarted.listEvents(session.id);
      assert.deepEqual(events.map(event => event.type), [
        "session.created",
        "application.registered"
      ]);
      assert.deepEqual(restarted.listEvents(session.id, events[0].id), events.slice(1));
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PID identity mismatch blocks termination and becomes a terminal safety state", async () => {
  const native = new FakeNativeManager();
  const supervisor = memorySupervisor(native);
  try {
    const session = supervisor.createSession();
    const { application } = await supervisor.launchApplication(session.id, "com.example.Original");
    native.inspectResults.push({
      ok: false,
      pid: application.pid,
      error: "PID does not match expected application",
      actualBundleIdentifier: "com.example.Reused"
    });

    await expectRuntimeError(
      supervisor.terminateApplication(session.id, application.id),
      409,
      "PROCESS_IDENTITY_MISMATCH"
    );
    assert.equal(native.terminateCalls.length, 0);
    const current = await supervisor.getApplication(session.id, application.id, false);
    assert.equal(current.status, "unknown");
    assert.equal(current.processIdentity, "mismatch");
    const inspections = native.inspectCalls.length;
    await supervisor.reconcile();
    assert.equal(native.inspectCalls.length, inspections);
  } finally {
    await supervisor.close();
  }
});

test("unaccepted termination is reported as a failure without claiming exit", async () => {
  const native = new FakeNativeManager();
  const supervisor = memorySupervisor(native);
  try {
    const session = supervisor.createSession();
    const { application } = await supervisor.launchApplication(session.id, "com.example.Refuses");
    native.terminateResults.push({
      ok: true,
      pid: application.pid,
      running: true,
      terminationRequested: false
    });

    await expectRuntimeError(
      supervisor.terminateApplication(session.id, String(application.pid)),
      409,
      "TERMINATION_NOT_ACCEPTED"
    );
    const current = await supervisor.getApplication(session.id, application.id, false);
    assert.equal(current.status, "running");
    assert.match(current.lastError ?? "", /not accepted/);
  } finally {
    await supervisor.close();
  }
});

test("asynchronous termination is reconciled to exit and relaunch gets a new stable ID", async () => {
  const native = new FakeNativeManager();
  const supervisor = memorySupervisor(native);
  try {
    const session = supervisor.createSession();
    const first = await supervisor.launchApplication(session.id, "com.example.Relaunch");
    native.terminateResults.push({
      ok: true,
      pid: first.application.pid,
      running: true,
      terminationRequested: true
    });
    const termination = await supervisor.terminateApplication(session.id, first.application.id);
    assert.equal(termination.application.status, "termination_requested");

    native.inspectResults.push({ ok: true, running: false });
    await supervisor.reconcile();
    const exited = await supervisor.getApplication(session.id, first.application.id, false);
    assert.equal(exited.status, "exited");
    assert.ok(exited.exitedAt);

    const second = await supervisor.launchApplication(session.id, "com.example.Relaunch");
    assert.equal(second.created, true);
    assert.notEqual(second.application.id, first.application.id);
    assert.notEqual(second.application.pid, first.application.pid);
  } finally {
    await supervisor.close();
  }
});

test("active polling observes process exit without an HTTP request", async () => {
  const native = new FakeNativeManager();
  const supervisor = memorySupervisor(native, 10);
  try {
    await supervisor.start();
    const session = supervisor.createSession();
    const { application } = await supervisor.launchApplication(session.id, "com.example.Polled");
    native.inspectResults.push({ ok: true, running: false });

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const current = await supervisor.getApplication(session.id, application.id, false);
      if (current.status === "exited") {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Polling did not observe process exit");
  } finally {
    await supervisor.close();
  }
});

test("pre-existing and cross-session shared processes are distinguished and protected", async () => {
  const native = new FakeNativeManager();
  native.launchResults.push(
    {
      ok: true,
      pid: 500,
      name: "Shared",
      bundleIdentifier: "com.example.Shared",
      bundleURL: "/Applications/Shared.app",
      processReused: true,
      processExistedBeforeLaunch: true
    },
    {
      ok: true,
      pid: 500,
      name: "Shared",
      bundleIdentifier: "com.example.Shared",
      bundleURL: "/Applications/Shared.app",
      preExisting: true
    },
    {
      ok: true,
      pid: 501,
      name: "Unknown origin",
      bundleIdentifier: "com.example.Unknown",
      bundleURL: "/Applications/Unknown.app"
    }
  );
  const supervisor = memorySupervisor(native);
  try {
    const firstSession = supervisor.createSession();
    const secondSession = supervisor.createSession();
    const first = await supervisor.launchApplication(firstSession.id, "com.example.Shared");
    assert.equal(first.application.processOrigin, "pre_existing");
    const second = await supervisor.launchApplication(secondSession.id, "com.example.Shared");
    assert.equal(second.application.processOrigin, "shared");
    assert.equal(
      (await supervisor.getApplication(firstSession.id, first.application.id, false)).processOrigin,
      "shared"
    );

    await expectRuntimeError(
      supervisor.terminateApplication(firstSession.id, first.application.id),
      409,
      "APPLICATION_SHARED"
    );
    assert.equal(native.terminateCalls.length, 0);

    const unknown = await supervisor.launchApplication(firstSession.id, "com.example.Unknown");
    assert.equal(unknown.application.processOrigin, "unknown");
  } finally {
    await supervisor.close();
  }
});

test("duplicate launch is idempotent and inconsistent native identity is rejected", async () => {
  const native = new FakeNativeManager();
  const supervisor = memorySupervisor(native);
  try {
    const session = supervisor.createSession();
    const first = await supervisor.launchApplication(session.id, "com.example.Duplicate");
    const duplicate = await supervisor.launchApplication(session.id, "com.example.Duplicate");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.application.id, first.application.id);
    assert.equal(native.launchCalls.length, 1);

    native.launchResults.push({
      ok: true,
      pid: 999,
      name: "Wrong",
      bundleIdentifier: "com.example.Wrong",
      bundleURL: "/Applications/Wrong.app"
    });
    await expectRuntimeError(
      supervisor.launchApplication(session.id, "com.example.Expected"),
      502,
      "NATIVE_MANAGER_INVALID_RESPONSE"
    );
    await expectRuntimeError(
      supervisor.launchApplication("not-a-uuid", "com.example.Expected"),
      400,
      "INVALID_SESSION_ID"
    );
  } finally {
    await supervisor.close();
  }
});


test("sole pre-existing applications cannot be terminated through a session", async () => {
  const native = new FakeNativeManager();
  native.launchResults.push({
    ok: true,
    pid: 700,
    name: "Existing",
    bundleIdentifier: "com.example.Existing",
    bundleURL: "/Applications/Existing.app",
    launchDate: "2026-01-01T00:00:00.000Z",
    processReused: true,
    processExistedBeforeLaunch: true
  });
  const supervisor = memorySupervisor(native);
  try {
    const session = supervisor.createSession();
    const { application } = await supervisor.launchApplication(
      session.id,
      "com.example.Existing"
    );
    assert.equal(application.processOrigin, "pre_existing");
    await expectRuntimeError(
      supervisor.terminateApplication(session.id, application.id),
      409,
      "APPLICATION_PRE_EXISTING"
    );
    assert.equal(native.terminateCalls.length, 0);
  } finally {
    await supervisor.close();
  }
});

test("same-bundle PID reuse is detected by launchDate and blocks the old record", async () => {
  const native = new FakeNativeManager();
  native.launchResults.push(
    {
      ok: true,
      pid: 701,
      name: "Original",
      bundleIdentifier: "com.example.ReusedPid",
      bundleURL: "/Applications/ReusedPid.app",
      launchDate: "2026-01-01T00:00:00.000Z",
      processReused: false,
      processExistedBeforeLaunch: false
    },
    {
      ok: true,
      pid: 701,
      name: "Replacement",
      bundleIdentifier: "com.example.ReusedPid",
      bundleURL: "/Applications/ReusedPid.app",
      launchDate: "2026-01-02T00:00:00.000Z",
      processReused: false,
      processExistedBeforeLaunch: false
    }
  );
  const supervisor = memorySupervisor(native);
  try {
    const firstSession = supervisor.createSession();
    const secondSession = supervisor.createSession();
    const original = await supervisor.launchApplication(
      firstSession.id,
      "com.example.ReusedPid"
    );
    await supervisor.launchApplication(secondSession.id, "com.example.ReusedPid");
    const stale = await supervisor.getApplication(
      firstSession.id,
      original.application.id,
      false
    );
    assert.equal(stale.processIdentity, "mismatch");
    await expectRuntimeError(
      supervisor.terminateApplication(firstSession.id, original.application.id),
      409,
      "PROCESS_IDENTITY_MISMATCH"
    );
    assert.equal(native.terminateCalls.length, 0);
  } finally {
    await supervisor.close();
  }
});

test("close waits for an in-flight native launch before closing SQLite", async () => {
  const native = new FakeNativeManager();
  let finishLaunch!: (result: NativeResult) => void;
  native.launchResults.length = 0;
  const originalLaunch = native.launch.bind(native);
  native.launch = async bundleIdentifier => {
    if (bundleIdentifier !== "com.example.SlowLaunch") {
      return originalLaunch(bundleIdentifier);
    }
    return new Promise<NativeResult>(resolve => {
      finishLaunch = resolve;
    });
  };
  const supervisor = memorySupervisor(native);
  const session = supervisor.createSession();
  const launching = supervisor.launchApplication(session.id, "com.example.SlowLaunch");
  let closed = false;
  const closing = supervisor.close().then(() => {
    closed = true;
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, false);
  finishLaunch({
    ok: true,
    pid: 702,
    name: "Slow",
    bundleIdentifier: "com.example.SlowLaunch",
    bundleURL: "/Applications/Slow.app",
    launchDate: "2026-01-01T00:00:00.000Z",
    processReused: false
  });
  await launching;
  await closing;
  assert.equal(closed, true);
});
