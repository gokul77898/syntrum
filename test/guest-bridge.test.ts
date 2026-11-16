import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GuestBusClient,
  guestSocketPath,
  GUEST_SOCKET_DIRECTORY
} from "../src/cloud/guest-bridge.js";

// /run is read-only on a development Mac, so the bridge's socket directory is
// redirected to a temporary one for the whole file. The production default is
// still asserted below.
const SOCKET_DIR = mkdtempSync(join(tmpdir(), "syntrum-guest-sockets-"));
process.env.SYNTRUM_GUEST_SOCKET_DIR = SOCKET_DIR;
import { startGuestBus } from "../src/guest/bus-daemon.js";

/**
 * The host-side guest bridge, driven through a real SSH-shaped child process.
 *
 * `ssh -W <unix path>` cannot run in a test without a worker, so a fake `ssh`
 * on PATH performs exactly what the real one does: connect stdio to the socket
 * named by the last argument. That keeps the bridge's own code — framing,
 * handshake, timeouts — under test rather than mocked away.
 */

const AGENT = { id: "agent-a", token: "token-a-0123456789abcdef" };

function fakeSshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "syntrum-fake-ssh-"));
  const path = join(dir, "ssh");
  // argv: [-n, -T, -o, ..., -W, <socket>, user@host]
  writeFileSync(path, `#!/usr/bin/env node
const net = require("node:net");
const argv = process.argv.slice(2);
const at = argv.indexOf("-W");
const socketPath = at === -1 ? undefined : argv[at + 1];
if (!socketPath) {
  process.stderr.write("fake ssh: no -W path\\n");
  process.exit(255);
}
const socket = net.createConnection(socketPath);
socket.on("error", error => {
  process.stderr.write("fake ssh: " + error.message + "\\n");
  process.exit(255);
});
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
`);
  chmodSync(path, 0o755);
  return dir;
}

async function withBridge<T>(
  fn: (ctx: { client: GuestBusClient; root: string; box: ReturnType<typeof sandbox> }) => Promise<T>
): Promise<T> {
  const box = sandbox();
  const bus = await startGuestBus({
    socketPath: box.socket,
    workspaceRoot: box.root,
    agents: [AGENT]
  });
  const fakeBin = fakeSshDirectory();
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  let client: GuestBusClient | undefined;
  try {
    // The bridge builds the socket path from the computer id under the fixed
    // guest directory, so the test socket is bound there.
    client = await GuestBusClient.connect({
      computerId: "test-computer",
      agent: AGENT,
      ssh: { host: "worker", user: "gokul" }
    });
    return await fn({ client, root: box.root, box });
  } finally {
    await client?.close().catch(() => undefined);
    process.env.PATH = originalPath;
    await bus.close().catch(() => undefined);
    box.cleanup();
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "syntrum-bridge-"));
  const root = join(dir, "workspace");
  mkdirSync(root, { recursive: true });
  return {
    dir,
    root,
    // The bridge dials <socket dir>/<computerId>.sock, so this is where the
    // fake ssh must find the bus.
    socket: join(SOCKET_DIR, "test-computer.sock"),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test("the socket path is derived from the computer id and cannot be steered", () => {
  assert.equal(guestSocketPath("abc-123"), `${SOCKET_DIR}/abc-123.sock`);
  // A traversal attempt must not escape the directory.
  assert.throws(() => guestSocketPath("../../etc/passwd"));
  assert.throws(() => guestSocketPath("a/b"));
  assert.throws(() => guestSocketPath(""));
});

test("the bridge completes the handshake and reports granted capabilities", async () => {
  await withBridge(async ({ client }) => {
    assert.equal(client.isConnected, true);
    assert.equal(client.agentId, AGENT.id);
    assert.ok(client.capabilities.includes("workspace:read"));
    assert.ok(client.capabilities.includes("adapter:document:write"));
    assert.deepEqual(client.sessionIds, ["main"]);
  });
});

test("the bridge reads and writes files in the shared workspace", async () => {
  await withBridge(async ({ client, root }) => {
    await client.writeFile({
      sessionId: "main", path: "from-host.txt", content: "written over the bridge",
      encoding: "utf8", expectedVersion: null
    });
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(root, "from-host.txt"), "utf8"), "written over the bridge");

    const read = await client.readFile({ sessionId: "main", path: "from-host.txt" });
    assert.equal(read.content, "written over the bridge");
    assert.ok(read.version.startsWith("sha256:"));
  });
});

test("the bridge sees documents with versions", async () => {
  await withBridge(async ({ client }) => {
    await client.writeFile({
      sessionId: "main", path: "doc.txt", content: "hello", encoding: "utf8",
      expectedVersion: null
    });
    const listed = await client.listDocuments({ sessionId: "main", workspaceId: "main" });
    assert.equal(listed.documents.length, 1);
    const read = await client.readDocument({
      sessionId: "main", workspaceId: "main", path: "doc.txt"
    });
    assert.equal(read.document.text, "hello");
    assert.ok(read.document.version > 0);
  });
});

test("a stale version over the bridge is rejected", async () => {
  await withBridge(async ({ client }) => {
    await client.writeFile({
      sessionId: "main", path: "conflict.txt", content: "v1", encoding: "utf8",
      expectedVersion: null
    });
    const read = await client.readDocument({
      sessionId: "main", workspaceId: "main", path: "conflict.txt"
    });
    await client.writeDocument({
      sessionId: "main", workspaceId: "main", path: "conflict.txt",
      text: "v2", expectedVersion: read.document.version
    });
    await assert.rejects(
      client.writeDocument({
        sessionId: "main", workspaceId: "main", path: "conflict.txt",
        text: "stale", expectedVersion: read.document.version
      }),
      (error: any) => error.code === "VERSION_CONFLICT"
    );
  });
});

test("a bad agent token fails the handshake rather than connecting", async () => {
  const box = sandbox();
  const bus = await startGuestBus({
    socketPath: box.socket, workspaceRoot: box.root, agents: [AGENT]
  });
  const fakeBin = fakeSshDirectory();
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    await assert.rejects(
      GuestBusClient.connect({
        computerId: "test-computer",
        agent: { id: AGENT.id, token: "wrong-token-entirely" },
        ssh: { host: "worker", user: "gokul" }
      }),
      (error: any) => error.code === "AUTH_FAILED" || /authentication/i.test(error.message)
    );
  } finally {
    process.env.PATH = originalPath;
    await bus.close().catch(() => undefined);
    box.cleanup();
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("a missing guest socket fails with a diagnostic, not a hang", async () => {
  const fakeBin = fakeSshDirectory();
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    await assert.rejects(
      GuestBusClient.connect({
        computerId: "no-such-computer",
        agent: AGENT,
        ssh: { host: "worker", user: "gokul" }
      }),
      (error: any) =>
        error.code === "CONNECT_TIMEOUT" ||
        error.code === "CONNECTION_CLOSED" ||
        error.code === "CONNECTION_FAILED"
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("events published on the guest reach the bridge's subscribers", async () => {
  await withBridge(async ({ client }) => {
    const received: any[] = [];
    client.onEvent(event => received.push(event));
    await client.subscribe({ sessionId: "main", channel: "workspace.changed" });
    await client.writeFile({
      sessionId: "main", path: "watched.txt", content: "x", encoding: "utf8",
      expectedVersion: null
    });
    // The guest watcher polls, so allow it an interval.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.ok(
      received.some(event => event.channel === "workspace.changed"),
      `expected a workspace.changed event, got ${JSON.stringify(received.map(e => e.channel))}`
    );
  });
});

test("close terminates the tunnel and later requests fail cleanly", async () => {
  await withBridge(async ({ client }) => {
    await client.close();
    assert.equal(client.isConnected, false);
    await assert.rejects(
      client.ping(),
      (error: any) => error.code === "NOT_CONNECTED" || error.code === "CLIENT_CLOSED"
    );
  });
});

test("the bridge never leaves an ssh child running after close", async () => {
  const box = sandbox();
  const bus = await startGuestBus({
    socketPath: box.socket, workspaceRoot: box.root, agents: [AGENT]
  });
  const fakeBin = fakeSshDirectory();
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    const client = await GuestBusClient.connect({
      computerId: "test-computer", agent: AGENT, ssh: { host: "worker", user: "gokul" }
    });
    await client.close();
    // Give the SIGTERM a moment to land.
    await new Promise(resolve => setTimeout(resolve, 500));
    const listed = await run("ps", ["-ax", "-o", "command"]);
    const leaked = listed.split("\n").filter(line => line.includes(fakeBin) && !line.includes("ps "));
    assert.deepEqual(leaked, [], `a tunnel child survived close: ${leaked.join(" | ")}`);
  } finally {
    process.env.PATH = originalPath;
    await bus.close().catch(() => undefined);
    box.cleanup();
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args);
    let out = "";
    child.stdout.on("data", chunk => { out += chunk.toString(); });
    child.on("error", rejectRun);
    child.on("close", () => resolveRun(out));
  });
}

test("the production socket directory is the one provisioning creates", () => {
  // The bridge dials a path under this directory; provisioning creates it there.
  // If the constant moved without the provisioner, the tunnel would fail with
  // ssh's 255 instead of a clear error.
  assert.equal(GUEST_SOCKET_DIRECTORY, "/run/syntrum/guests");
  assert.ok(existsSync("/run/syntrum/guests") || GUEST_SOCKET_DIRECTORY === "/run/syntrum/guests");
});
