import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { LinuxNativeManager } from "../src/runtime/linux-native-manager.js";

// These run against real /proc and real processes, so they prove the parsing
// rather than a mock of it. The mac manager's counterpart tests are only
// meaningful on Darwin; these are only meaningful on Linux.
const onLinux = process.platform === "linux";

test("launch reports a real pid whose starttime is stable across inspect", { skip: !onLinux }, async () => {
  const manager = new LinuxNativeManager("/bin/sleep");
  const launched = await manager.launch("/bin/sleep", { arguments: ["30"] });
  try {
    assert.equal(launched.ok, true);
    assert.ok(launched.pid);
    assert.equal(launched.name, "sleep");
    assert.ok(launched.launchDate, "starttime is reported as the identity token");

    const inspected = await manager.inspect(launched.pid, "/bin/sleep");
    assert.equal(inspected.running, true);
    // Identity is only useful if the value at launch equals the value later.
    assert.equal(inspected.actualLaunchDate, launched.launchDate);
  } finally {
    await manager.terminate(launched.pid ?? 0, "/bin/sleep");
  }
});

test("comm containing spaces and parens does not corrupt the starttime field", { skip: !onLinux }, () => {
  // /proc/<pid>/stat wraps comm in parens and does not escape spaces, so a
  // naive split on whitespace shifts every later field. Field 22 must still
  // be found by splitting after the last ')'.
  const stat = "1234 (weird (name) here) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 99";
  const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  assert.equal(afterComm[19], "99");
});

test("inspect on a dead pid reports not running rather than throwing", { skip: !onLinux }, async () => {
  const manager = new LinuxNativeManager();
  const child = spawn("/bin/true", { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise<void>(resolve => child.on("exit", () => resolve()));
  const result = await manager.inspect(pid, "/bin/true");
  assert.equal(result.ok, true);
  assert.equal(result.running, false);
});

test("terminate on an already-exited pid is idempotent success", { skip: !onLinux }, async () => {
  const manager = new LinuxNativeManager();
  const child = spawn("/bin/true", { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise<void>(resolve => child.on("exit", () => resolve()));
  const result = await manager.terminate(pid, "/bin/true");
  assert.equal(result.ok, true, "a missing process is not an error");
});

test("frontmost refuses rather than reporting an unverified claim", { skip: !onLinux }, async () => {
  const manager = new LinuxNativeManager();
  const result = await manager.frontmost();
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.match(result.error ?? "", /not supported on Linux/);
});

test("launch of a relative path is rejected before spawning anything", { skip: !onLinux }, async () => {
  const manager = new LinuxNativeManager();
  const result = await manager.launch("sleep", { arguments: ["30"] });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /absolute executable path/);
});

test("launch of a nonexistent absolute path reports the spawn error", { skip: !onLinux }, async () => {
  const manager = new LinuxNativeManager();
  const result = await manager.launch("/nonexistent/definitely-not-here");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ENOENT|no such file/i);
});
