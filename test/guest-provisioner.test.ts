import assert from "node:assert/strict";
import test from "node:test";

import {
  CUDA_RUNTIME_PACKAGES,
  GuestProvisioner,
  cudaRuntimeScript,
  nodeInstallScript,
  resolveNodePlatform
} from "../src/cloud/index.js";
import { CUDA_RUNTIME_LIBRARY } from "../src/gpu/types.js";

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

// Observed live: Node's arm64 build needs libatomic.so.1, which a minimal
// image does not ship, so node existed on disk but could not exec. Installing
// the toolchain without its shared libraries is not an install.
test("the install script installs Node's shared-library dependencies", () => {
  const script = nodeInstallScript("v26.13.0", "linux-arm64");
  assert.match(script, /apt-get.*install[^\n]*libatomic1/);
  // The final line is what proves it executes; it must come after the install.
  assert.ok(
    script.indexOf("libatomic1") < script.lastIndexOf("/usr/local/bin/node --version"),
    "the runtime packages are installed before node is proven to run"
  );
});

test("the apt date override is opt-in and off by default", () => {
  assert.equal(nodeInstallScript("v26.13.0", "linux-arm64").includes("Check-Date"), false);
  assert.match(
    nodeInstallScript("v26.13.0", "linux-arm64", true),
    /Check-Date=false/
  );
});

test("the install script fails closed when curl or xz is missing", () => {
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

// ── CUDA runtime ─────────────────────────────────────────────────────────

// The bug this exists for: the workload asked for libcudart.so.1, which no
// Ubuntu 24.04 package provides, so a perfectly built GPU guest failed to
// dlopen. The soname the workload uses and the soname the provisioner proves
// must be the same string.
test("the CUDA runtime script proves the exact library the workload loads", () => {
  const script = cudaRuntimeScript();
  assert.match(script, new RegExp(`ctypes\\.CDLL\\("${CUDA_RUNTIME_LIBRARY.replace(/\./g, "\\.")}"\\)`));
  // The workload's own constant, so the two cannot drift apart.
  assert.match(script, /libcudart\.so\.12/);
  assert.equal(script.includes("libcudart.so.1\""), false, "the .so.1 soname does not exist");
});

test("the CUDA runtime script installs the package and the interpreter the workload needs", () => {
  const script = cudaRuntimeScript();
  assert.ok(CUDA_RUNTIME_PACKAGES.includes("libcudart12"));
  assert.ok(CUDA_RUNTIME_PACKAGES.includes("python3"));
  assert.match(script, /apt-get.*install[^\n]*libcudart12/);
  assert.match(script, /apt-get.*install[^\n]*python3/);
  // The workload is Python; a guest without it fails in a way that looks like a
  // CUDA problem rather than a missing interpreter.
  assert.ok(script.indexOf("libcudart12") < script.lastIndexOf("ctypes.CDLL"));
});

// libcudart12 is in multiverse, which a minimal image may not have enabled.
// apt reports that as "no installation candidate", which names nothing useful.
test("a missing package names multiverse instead of apt's generic failure", () => {
  const script = cudaRuntimeScript();
  assert.match(script, /apt-cache policy libcudart12/);
  assert.match(script, /multiverse/);
  assert.ok(
    script.indexOf("apt-cache policy") < script.lastIndexOf("apt-get"),
    "the candidate check must run before the install it explains"
  );
});

test("the CUDA install is opt-in for the apt date override, like the Node path", () => {
  assert.equal(cudaRuntimeScript().includes("Check-Date"), false);
  assert.match(cudaRuntimeScript(true), /Check-Date=false/);
});

test("installCudaRuntime reports the library it proved, and fails on anything else", async () => {
  const provisioner = new GuestProvisioner(async () => `${CUDA_RUNTIME_LIBRARY}\n`);
  assert.deepEqual(await provisioner.installCudaRuntime("computer-1"), {
    packages: CUDA_RUNTIME_PACKAGES,
    library: CUDA_RUNTIME_LIBRARY
  });

  // A guest whose install silently did nothing must not be reported as ready.
  const silent = new GuestProvisioner(async () => "");
  await assert.rejects(silent.installCudaRuntime("computer-1"), /expected libcudart\.so\.12/);
});

test("verifyCuda needs a device, and says so rather than swallowing the failure", async () => {
  const noGpu = new GuestProvisioner(async () => {
    throw new Error("CUDA error 100: no CUDA-capable device is detected");
  });
  await assert.rejects(
    noGpu.verifyCuda("computer-1"),
    /cannot create a CUDA context.*no CUDA-capable device/
  );

  const working = new GuestProvisioner(async () => "syntrum-cuda-ready\n");
  await working.verifyCuda("computer-1");
});
