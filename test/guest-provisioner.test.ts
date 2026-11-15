import assert from "node:assert/strict";
import test from "node:test";

import {
  GuestProvisioner,
  nodeInstallScript,
  resolveNodePlatform
} from "../src/cloud/index.js";

test("guest architecture maps to the platform Node publishes", () => {
  assert.equal(resolveNodePlatform("aarch64"), "linux-arm64");
  assert.equal(resolveNodePlatform("x86_64"), "linux-x64");
  assert.equal(resolveNodePlatform("arm64"), "linux-arm64");
});

test("an unknown guest architecture is refused rather than guessed", () => {
  assert.throws(() => resolveNodePlatform("riscv64"), /Unsupported guest architecture/);
  assert.throws(() => resolveNodePlatform(""), /Unsupported guest architecture/);
});

// The script reaches a root shell in the guest, so its inputs are validated
// rather than interpolated. A version carrying shell metacharacters must not
// survive into the string at all.
test("a version string that is not a release tag is refused", () => {
  assert.throws(() => nodeInstallScript("v26.13.0; rm -rf /", "linux-arm64"), /Invalid Node version/);
  assert.throws(() => nodeInstallScript("26.13.0", "linux-arm64"), /Invalid Node version/);
  assert.throws(() => nodeInstallScript("latest", "linux-arm64"), /Invalid Node version/);
});

test("an unrecognised platform is refused", () => {
  assert.throws(() => nodeInstallScript("v26.13.0", "linux-mips"), /Invalid Node platform/);
});

test("the install script verifies the download against the published checksum", () => {
  const script = nodeInstallScript("v26.13.0", "linux-arm64");
  assert.match(script, /https:\/\/nodejs\.org\/dist\/v26\.13\.0\/node-v26\.13\.0-linux-arm64\.tar\.xz/);
  assert.match(script, /SHASUMS256\.txt/);
  assert.match(script, /sha256sum -c expected\.txt/);
  // The failure that actually happened in the field was trusting an unverified
  // tarball; assert it cannot be extracted before the checksum passes.
  const verifyAt = script.indexOf("sha256sum -c");
  const extractAt = script.indexOf("tar -xJf");
  assert.ok(verifyAt > -1 && extractAt > -1 && verifyAt < extractAt,
    "the checksum is verified before extraction");
  assert.equal(script.includes("curl -fsSL https://nodejs.org/dist | "), false);
});

test("the script fails closed when curl or xz is missing", () => {
  const script = nodeInstallScript("v26.13.0", "linux-arm64");
  assert.match(script, /command -v curl/);
  assert.match(script, /command -v xz/);
  assert.match(script, /set -eu/);
});

test("installNode reads the guest's own architecture, not the worker's", async () => {
  const calls: string[][] = [];
  const provisioner = new GuestProvisioner(async (id, args) => {
    calls.push([...args]);
    if (args[0] === "uname") return "aarch64\n";
    return "v26.13.0\n";
  });
  const result = await provisioner.installNode("computer-1", "v26.13.0");
  assert.deepEqual(result, { version: "v26.13.0", platform: "linux-arm64" });
  assert.deepEqual(calls[0], ["uname", "-m"]);
  assert.match(calls[1][2] ?? "", /node-v26\.13\.0-linux-arm64\.tar\.xz/);
});

test("a guest that reports the wrong version after install is an error", async () => {
  const provisioner = new GuestProvisioner(async (_id, args) =>
    args[0] === "uname" ? "aarch64\n" : "v18.19.1\n"
  );
  await assert.rejects(
    provisioner.installNode("computer-1", "v26.13.0"),
    /reported v18\.19\.1, expected v26\.13\.0/
  );
});

test("verifyNodeSqlite surfaces a runtime that cannot load node:sqlite", async () => {
  const failing = new GuestProvisioner(async () => {
    throw new Error("Error: No such built-in module: node:sqlite");
  });
  await assert.rejects(
    failing.verifyNodeSqlite("computer-1"),
    /cannot use node:sqlite.*node:sqlite/
  );

  const ok = new GuestProvisioner(async () => "");
  await ok.verifyNodeSqlite("computer-1");
});
