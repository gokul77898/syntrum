import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdapterError,
  AgentIdentity,
  DocumentConflictError,
  DocumentSnapshot,
  VSCodeAdapter
} from "../src/adapters/index.js";

const agentA: AgentIdentity = { agentId: "agent-a", sessionId: "session-1" };
const agentB: AgentIdentity = { agentId: "agent-b", sessionId: "session-1" };

class MockExtension {
  private socket?: Socket;
  private buffer = "";
  private version = 7;
  private text = "initial text";
  requestCount = 0;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly rootPath: string
  ) {}

  async connect(): Promise<void> {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    const connected = new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          token: this.token,
          workspaces: [{ id: "main", rootPath: this.rootPath }]
        })}\n`);
        resolveConnect();
      });
      socket.once("error", rejectConnect);
    });
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line);
          if (message.type === "request") {
            this.handleRequest(message);
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
    await connected;
  }

  close(): void {
    this.socket?.destroy();
  }

  emitChange(path = "note.txt"): void {
    this.version += 1;
    this.send({
      type: "event",
      eventType: "document.changed",
      workspaceId: "main",
      path,
      version: this.version,
      dirty: true,
      origin: null
    });
  }

  private snapshot(): DocumentSnapshot {
    return {
      workspaceId: "main",
      path: "note.txt",
      text: this.text,
      version: this.version,
      languageId: "plaintext",
      dirty: false,
      eol: "lf"
    };
  }

  private handleRequest(request: Record<string, any>): void {
    this.requestCount += 1;
    if (request.operation === "document.list") {
      const { text: _text, eol: _eol, ...descriptor } = this.snapshot();
      this.send({ type: "response", id: request.id, result: [descriptor] });
      return;
    }
    if (request.operation === "document.read") {
      this.send({
        type: "event",
        eventType: "document.opened",
        workspaceId: "main",
        path: "note.txt",
        version: this.version,
        dirty: false,
        origin: null
      });
      this.send({ type: "response", id: request.id, result: this.snapshot() });
      return;
    }
    if (request.operation === "document.write") {
      if (request.expectedVersion !== this.version) {
        this.send({
          type: "response",
          id: request.id,
          error: {
            code: "VERSION_CONFLICT",
            message: "Document version conflict",
            details: { current: this.snapshot() }
          }
        });
        return;
      }
      this.text = request.text;
      this.version += 1;
      const snapshot = { ...this.snapshot(), dirty: true };
      this.send({
        type: "event",
        eventType: "document.changed",
        workspaceId: "main",
        path: "note.txt",
        version: this.version,
        dirty: true,
        origin: request.agent
      });
      this.send({ type: "response", id: request.id, result: snapshot });
      return;
    }
    throw new Error("Unexpected operation");
  }

  private send(message: unknown): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }
}

async function setup(t: test.TestContext, eventBufferSize = 100) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-os-dual-head-"));
  const rootPath = join(temporaryDirectory, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rootPath));
  await writeFile(join(rootPath, "note.txt"), "initial text");
  const canonicalRoot = await realpath(rootPath);
  const socketPath = join(rootPath, ".cloud-ai-os/test.sock");
  const adapter = new VSCodeAdapter({
    workspaces: [{ id: "main", rootPath }],
    socketPath,
    authToken: "test-token-with-at-least-16-characters",
    requestTimeoutMs: 1_000,
    eventBufferSize
  });
  await adapter.start();
  const extension = new MockExtension(
    socketPath,
    "test-token-with-at-least-16-characters",
    canonicalRoot
  );
  await extension.connect();
  await adapter.waitForWorkspace("main", 1_000);

  t.after(async () => {
    extension.close();
    await adapter.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  return { adapter, extension, rootPath, temporaryDirectory };
}

test("unit (mock extension): adapter performs versioned dual-head writes and attributes events", async t => {
  const { adapter } = await setup(t);
  const initial = await adapter.readDocument(agentA, "main", "note.txt");
  assert.equal(initial.text, "initial text");
  assert.equal(initial.version, 7);
  assert.deepEqual(await adapter.listDocuments(agentA, "main"), [{
    workspaceId: "main",
    path: "note.txt",
    version: 7,
    languageId: "plaintext",
    dirty: false
  }]);

  const writes = await Promise.allSettled([
    adapter.writeDocument(agentA, "main", "note.txt", "from A", {
      expectedVersion: initial.version
    }),
    adapter.writeDocument(agentB, "main", "note.txt", "from B", {
      expectedVersion: initial.version
    })
  ]);
  assert.equal(writes.filter(item => item.status === "fulfilled").length, 1);
  const rejected = writes.find(item => item.status === "rejected");
  assert.ok(rejected);
  assert.ok(rejected.reason instanceof DocumentConflictError);
  assert.equal(rejected.reason.current.version, 8);

  const changed = await adapter.readDocument(agentA, "main", "note.txt");
  const next = await adapter.writeDocument(agentB, "main", "note.txt", "second edit", {
    expectedVersion: changed.version
  });
  assert.equal(next.text, "second edit");
  assert.equal(next.version, 9);

  const eventsForA = await adapter.getEvents(agentA);
  const eventsForB = await adapter.getEvents(agentB);
  assert.deepEqual(eventsForA.events, eventsForB.events);
  const editEvents = eventsForA.events.filter(event => event.type === "document.changed");
  assert.equal(editEvents.length, 2);
  assert.ok(editEvents[0].origin);
  assert.ok(["agent-a", "agent-b"].includes(editEvents[0].origin!.agentId));
  assert.equal(editEvents[1].origin?.agentId, "agent-b");
  assert.equal(editEvents[1].origin?.sessionId, "session-1");
});

test("unit (mock extension): event pages use independent cursors and report buffer resets", async t => {
  const { adapter, extension } = await setup(t, 2);
  await new Promise<void>((resolveEvents, rejectEvents) => {
    const timer = setTimeout(
      () => rejectEvents(new Error("Timed out waiting for bridge events")),
      1_000
    );
    const unsubscribe = adapter.onEvent(event => {
      if (event.id === 3) {
        clearTimeout(timer);
        unsubscribe();
        resolveEvents();
      }
    });
    extension.emitChange();
    extension.emitChange();
    extension.emitChange();
  });

  const firstPage = await adapter.getEvents(agentA, { after: 0, limit: 1 });
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.reset, true);
  assert.equal(firstPage.oldestEventId, 2);

  const secondPage = await adapter.getEvents(agentB, {
    after: firstPage.events[0].id,
    limit: 1
  });
  assert.equal(secondPage.events.length, 1);
  assert.equal(secondPage.events[0].id, 3);
  assert.equal(secondPage.reset, false);
});

test("unit (mock extension): adapter rejects traversal and symlinks that leave the workspace", async t => {
  const { adapter, extension, rootPath, temporaryDirectory } = await setup(t);
  await writeFile(join(temporaryDirectory, "outside.txt"), "outside");
  await symlink(join(temporaryDirectory, "outside.txt"), join(rootPath, "escape.txt"));

  for (const path of ["../outside.txt", "/etc/passwd", "escape.txt"]) {
    await assert.rejects(
      adapter.readDocument(agentA, "main", path),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.ok(["INVALID_DOCUMENT_PATH", "DOCUMENT_NOT_FOUND"].includes(error.code));
        return true;
      }
    );
  }
  assert.equal(extension.requestCount, 0);
  await assert.rejects(adapter.readDocument(agentA, "missing", "note.txt"), {
    code: "UNKNOWN_WORKSPACE"
  });
});

test("unit (mock extension): a bad bridge token cannot register a workspace", async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-os-auth-"));
  const rootPath = join(temporaryDirectory, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rootPath));
  const canonicalRoot = await realpath(rootPath);
  const socketPath = join(rootPath, "adapter.sock");
  const adapter = new VSCodeAdapter({
    workspaces: [{ id: "main", rootPath }],
    socketPath,
    authToken: "correct-token-123456789"
  });
  await adapter.start();
  const extension = new MockExtension(socketPath, "wrong-token-123456789", canonicalRoot);
  t.after(async () => {
    extension.close();
    await adapter.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  await extension.connect();
  await new Promise(resolveWait => setTimeout(resolveWait, 50));

  assert.deepEqual(await adapter.listWorkspaces(agentA), [{
    id: "main",
    name: "main",
    connected: false
  }]);
  await assert.rejects(adapter.listDocuments(agentA, "main"), {
    code: "EXTENSION_NOT_CONNECTED"
  });
});


test("unit (mock extension): paginated cursors return every event without moving backward", async t => {
  const { adapter, extension } = await setup(t, 10);
  await new Promise<void>((resolveEvents, rejectEvents) => {
    const timer = setTimeout(
      () => rejectEvents(new Error("Timed out waiting for bridge events")),
      1_000
    );
    const unsubscribe = adapter.onEvent(event => {
      if (event.id === 5) {
        clearTimeout(timer);
        unsubscribe();
        resolveEvents();
      }
    });
    for (let index = 0; index < 5; index += 1) {
      extension.emitChange();
    }
  });

  const ids: number[] = [];
  let cursor = 0;
  for (const expectedLength of [2, 2, 1, 0]) {
    const page = await adapter.getEvents(agentA, { after: cursor, limit: 2 });
    assert.equal(page.events.length, expectedLength);
    assert.ok(page.nextEventId >= cursor);
    ids.push(...page.events.map(event => event.id));
    cursor = page.nextEventId;
  }
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  assert.equal(cursor, 5);
});

test("unit (mock extension): restart clears retained events and explicitly resets old cursors", async t => {
  const { adapter, extension, rootPath } = await setup(t);
  await new Promise<void>((resolveEvents, rejectEvents) => {
    const timer = setTimeout(
      () => rejectEvents(new Error("Timed out waiting for bridge event")),
      1_000
    );
    const unsubscribe = adapter.onEvent(() => {
      clearTimeout(timer);
      unsubscribe();
      resolveEvents();
    });
    extension.emitChange();
  });
  const beforeRestart = await adapter.getEvents(agentA);
  assert.equal(beforeRestart.nextEventId, 1);
  const { socketPath, authToken } = adapter.connectionInfo;

  extension.close();
  await adapter.close();
  await adapter.start();

  const reset = await adapter.getEvents(agentA, { after: 0 });
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.events, []);
  assert.equal(reset.oldestEventId, 0);
  const current = await adapter.getEvents(agentA, { after: beforeRestart.nextEventId });
  assert.equal(current.reset, false);
  assert.equal(current.nextEventId, beforeRestart.nextEventId);

  const canonicalRoot = await realpath(rootPath);
  const reconnected = new MockExtension(socketPath, authToken, canonicalRoot);
  t.after(() => reconnected.close());
  await reconnected.connect();
  await adapter.waitForWorkspace("main", 1_000);
  await new Promise<void>((resolveEvents, rejectEvents) => {
    const timer = setTimeout(
      () => rejectEvents(new Error("Timed out waiting for post-restart event")),
      1_000
    );
    const unsubscribe = adapter.onEvent(event => {
      if (event.id === 2) {
        clearTimeout(timer);
        unsubscribe();
        resolveEvents();
      }
    });
    reconnected.emitChange();
  });
  const afterRestart = await adapter.getEvents(agentA, { after: current.nextEventId });
  assert.equal(afterRestart.reset, false);
  assert.deepEqual(afterRestart.events.map(event => event.id), [2]);
  assert.equal(afterRestart.nextEventId, 2);
});

test("unit (mock extension): startup refuses an active socket without unlinking it", async t => {
  const { adapter, rootPath } = await setup(t);
  const socketPath = adapter.connectionInfo.socketPath;
  const second = new VSCodeAdapter({
    workspaces: [{ id: "main", rootPath }],
    socketPath,
    authToken: "test-token-with-at-least-16-characters"
  });
  t.after(() => second.close());

  await assert.rejects(second.start(), { code: "SOCKET_IN_USE" });
  assert.equal((await lstat(socketPath)).isSocket(), true);
  assert.equal((await adapter.listWorkspaces(agentA))[0].connected, true);
});

test("unit (mock extension): startup refuses to replace a non-socket path", async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-os-socket-file-"));
  const rootPath = join(temporaryDirectory, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rootPath));
  const socketPath = join(rootPath, "adapter.sock");
  await writeFile(socketPath, "do not remove");
  const adapter = new VSCodeAdapter({
    workspaces: [{ id: "main", rootPath }],
    socketPath,
    authToken: "test-token-with-at-least-16-characters"
  });
  t.after(async () => {
    await adapter.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await assert.rejects(adapter.start(), { code: "SOCKET_PATH_INVALID" });
  assert.equal((await lstat(socketPath)).isFile(), true);
});

test("unit (mock extension): startup replaces only a stale Unix socket", async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-os-stale-socket-"));
  const rootPath = join(temporaryDirectory, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rootPath));
  const socketPath = join(rootPath, "adapter.sock");
  const child = spawn(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
    socketPath
  ], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    child.stdout!.once("data", () => resolveReady());
    child.once("error", rejectReady);
    child.once("exit", code => rejectReady(new Error(`Socket fixture exited: ${code}`)));
  });
  child.kill("SIGKILL");
  await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  const staleIdentity = await lstat(socketPath);
  assert.equal(staleIdentity.isSocket(), true);

  const adapter = new VSCodeAdapter({
    workspaces: [{ id: "main", rootPath }],
    socketPath,
    authToken: "test-token-with-at-least-16-characters"
  });
  t.after(async () => {
    await adapter.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  await adapter.start();
  const replacementIdentity = await lstat(socketPath);
  assert.equal(replacementIdentity.isSocket(), true);
  assert.notEqual(replacementIdentity.ino, staleIdentity.ino);

  const canonicalRoot = await realpath(rootPath);
  const extension = new MockExtension(
    socketPath,
    "test-token-with-at-least-16-characters",
    canonicalRoot
  );
  t.after(() => extension.close());
  await extension.connect();
  await adapter.waitForWorkspace("main", 1_000);
  assert.equal((await adapter.listWorkspaces(agentA))[0].connected, true);
});

test("unit (mock extension): close leaves a replacement socket owned by another server", async t => {
  const { adapter, extension } = await setup(t);
  const socketPath = adapter.connectionInfo.socketPath;
  extension.close();
  const server = (adapter as unknown as { server: Server }).server;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  const replacement = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    replacement.once("error", rejectListen);
    replacement.listen(socketPath, () => resolveListen());
  });
  t.after(async () => {
    if (replacement.listening) {
      await new Promise<void>(resolveClose => replacement.close(() => resolveClose()));
    }
  });
  const replacementIdentity = await lstat(socketPath);

  await adapter.close();
  const remainingIdentity = await lstat(socketPath);
  assert.equal(remainingIdentity.isSocket(), true);
  assert.equal(remainingIdentity.dev, replacementIdentity.dev);
  assert.equal(remainingIdentity.ino, replacementIdentity.ino);
});
