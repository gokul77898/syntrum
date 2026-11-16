import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startGuestBus, versionNumber, languageOf, WORKSPACE_ID } from "../src/guest/bus-daemon.js";
import { BusClient } from "../src/bus/client.js";

/**
 * The in-guest bus daemon, exercised over a real Unix socket. Nothing here is
 * mocked: the same socket, handshake, versioned write and conflict path the
 * guest runs.
 *
 * Two write routes exist and the distinction matters:
 *   workspace.write with expectedVersion null  -> create a file that must not exist
 *   document.write with a positive version     -> update a file you have read
 * The bus rejects a document version below 1, so creation cannot go through the
 * document path at all.
 */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "syntrum-guest-bus-"));
  const root = join(dir, "workspace");
  mkdirSync(root, { recursive: true });
  return {
    dir,
    root,
    socket: join(dir, "bus.sock"),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

const AGENT = { id: "agent-a", token: "token-a-0123456789abcdef" };

async function withBus<T>(
  fn: (ctx: {
    client: BusClient;
    box: ReturnType<typeof sandbox>;
  }) => Promise<T>
): Promise<T> {
  const box = sandbox();
  const bus = await startGuestBus({
    socketPath: box.socket,
    workspaceRoot: box.root,
    agents: [AGENT]
  });
  const client = await BusClient.connect({
    socketPath: box.socket,
    agent: { id: AGENT.id, token: AGENT.token }
  });
  try {
    return await fn({ client, box });
  } finally {
    await client.close().catch(() => undefined);
    await bus.close().catch(() => undefined);
    box.cleanup();
  }
}

/** Creates a file through the create route: expectedVersion null. */
function create(client: BusClient, path: string, content: string, encoding: "utf8" = "utf8") {
  return client.writeFile({ sessionId: "main", path, content, encoding, expectedVersion: null });
}

test("an agent with the right token connects and sees the shared workspace", async () => {
  await withBus(async ({ client }) => {
    const workspaces = await client.listWorkspaces({ sessionId: "main" });
    assert.equal(workspaces.workspaces.length, 1);
    assert.equal(workspaces.workspaces[0].id, WORKSPACE_ID);
    assert.equal(workspaces.workspaces[0].connected, true);
  });
});

test("a wrong token is refused at the handshake", async () => {
  const box = sandbox();
  const bus = await startGuestBus({
    socketPath: box.socket, workspaceRoot: box.root, agents: [AGENT]
  });
  try {
    await assert.rejects(
      BusClient.connect({ socketPath: box.socket, agent: { id: AGENT.id, token: "wrong-token" } }),
      /AUTH_FAILED|authentication/i
    );
  } finally {
    await bus.close().catch(() => undefined);
    box.cleanup();
  }
});

test("an unknown agent id is refused", async () => {
  const box = sandbox();
  const bus = await startGuestBus({
    socketPath: box.socket, workspaceRoot: box.root, agents: [AGENT]
  });
  try {
    await assert.rejects(
      BusClient.connect({ socketPath: box.socket, agent: { id: "not-a-grant", token: AGENT.token } }),
      /AUTH_FAILED|authentication/i
    );
  } finally {
    await bus.close().catch(() => undefined);
    box.cleanup();
  }
});

test("an agent writes a file the guest filesystem actually receives", async () => {
  await withBus(async ({ client, box }) => {
    const written = await create(client, "notes.txt", "hello from an agent");
    assert.ok(written.version.startsWith("sha256:"), "the store versions by content hash");
    // The point of Phase 4: the file is on the same disk the human's desktop
    // reads, not in a separate agent store.
    assert.equal(readFileSync(join(box.root, "notes.txt"), "utf8"), "hello from an agent");
  });
});

test("a stale version is rejected and the file is left untouched", async () => {
  await withBus(async ({ client, box }) => {
    await create(client, "shared.txt", "original");
    const read = await client.readDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID, path: "shared.txt"
    });
    const staleVersion = read.document.version;

    // Another writer changes the file behind the first agent's back.
    await client.writeDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID,
      path: "shared.txt", text: "someone else wrote this", expectedVersion: staleVersion
    });

    // The first agent now writes holding a version it no longer owns.
    await assert.rejects(
      client.writeDocument({
        sessionId: "main", workspaceId: WORKSPACE_ID,
        path: "shared.txt", text: "stale write", expectedVersion: staleVersion
      }),
      (error: any) => error.code === "VERSION_CONFLICT"
    );

    assert.equal(
      readFileSync(join(box.root, "shared.txt"), "utf8"),
      "someone else wrote this",
      "a rejected write must not modify the file"
    );
  });
});

test("creating a file that already exists is refused rather than clobbering", async () => {
  await withBus(async ({ client, box }) => {
    await create(client, "existing.txt", "first");
    await assert.rejects(
      create(client, "existing.txt", "second"),
      (error: any) => error.code === "VERSION_CONFLICT"
    );
    assert.equal(readFileSync(join(box.root, "existing.txt"), "utf8"), "first");
  });
});

test("a document write with the version from a fresh read succeeds", async () => {
  await withBus(async ({ client }) => {
    await create(client, "read-then-write.txt", "v1");
    const read = await client.readDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID, path: "read-then-write.txt"
    });
    const updated = await client.writeDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID,
      path: "read-then-write.txt", text: "v2", expectedVersion: read.document.version
    });
    assert.equal(updated.document.text, "v2");
    assert.notEqual(updated.document.version, read.document.version, "the version advanced");
  });
});

test("writing a document that does not exist reports it", async () => {
  await withBus(async ({ client }) => {
    await assert.rejects(
      client.writeDocument({
        sessionId: "main", workspaceId: WORKSPACE_ID,
        path: "missing.txt", text: "x", expectedVersion: 1
      }),
      (error: any) => error.code === "FILE_NOT_FOUND"
    );
  });
});

test("a path escaping the workspace is refused", async () => {
  await withBus(async ({ client, box }) => {
    for (const path of ["../escape.txt", "/etc/passwd", "a/../../escape.txt"]) {
      await assert.rejects(
        create(client, path, "nope"),
        (error: any) => typeof error.code === "string",
        `'${path}' must be refused`
      );
    }
    assert.equal(existsSync(join(box.dir, "escape.txt")), false, "nothing escaped the root");
  });
});

test("a symlink pointing outside the workspace is refused", async () => {
  await withBus(async ({ client, box }) => {
    const outside = join(box.dir, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(box.root, "link.txt"));
    await assert.rejects(
      client.readDocument({ sessionId: "main", workspaceId: WORKSPACE_ID, path: "link.txt" }),
      (error: any) => error.code === "SYMLINK_NOT_ALLOWED"
    );
  });
});

test("creating a file publishes a workspace.changed event", async () => {
  await withBus(async ({ client }) => {
    const received: any[] = [];
    client.onEvent(event => received.push(event));
    const subscription = await client.subscribe({ sessionId: "main", channel: "workspace.changed" });
    assert.ok(subscription.subscriptionId);

    await create(client, "evented.txt", "content");
    // The watcher polls, so allow it a scan interval plus slack.
    await new Promise(resolve => setTimeout(resolve, 2500));
    const event = received.find(e => e.channel === "workspace.changed");
    assert.ok(
      event,
      `expected a workspace.changed event, got ${JSON.stringify(received.map(e => e.channel))}`
    );
    assert.equal(event.data.path, "evented.txt");
    assert.equal(event.data.created, true);
  });
});

test("a document write publishes document.saved", async () => {
  await withBus(async ({ client }) => {
    await create(client, "doc.txt", "one");
    const received: any[] = [];
    client.onEvent(event => received.push(event));
    await client.subscribe({ sessionId: "main", channel: "document.saved" });
    const read = await client.readDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID, path: "doc.txt"
    });
    await client.writeDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID,
      path: "doc.txt", text: "two", expectedVersion: read.document.version
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(
      received.some(e => e.channel === "document.saved"),
      `expected document.saved, got ${JSON.stringify(received.map(e => e.channel))}`
    );
  });
});

test("a change made outside the bus is still announced to subscribers", async () => {
  await withBus(async ({ client, box }) => {
    // This is the human's desktop writing a file: the same disk, no bus call.
    const received: any[] = [];
    client.onEvent(event => received.push(event));
    await client.subscribe({ sessionId: "main", channel: "workspace.changed" });

    writeFileSync(join(box.root, "human-edit.txt"), "typed by a person\n");
    await new Promise(resolve => setTimeout(resolve, 2500));

    assert.ok(
      received.some(e => e.channel === "workspace.changed" && e.data.path === "human-edit.txt"),
      "an agent must observe the human's edit to the shared workspace"
    );
  });
});

test("listing reports files with a language and no false dirty flag", async () => {
  await withBus(async ({ client, box }) => {
    writeFileSync(join(box.root, "script.py"), "print(1)\n");
    writeFileSync(join(box.root, "notes.md"), "# hi\n");
    const listed = await client.listDocuments({ sessionId: "main", workspaceId: WORKSPACE_ID });
    const byPath = new Map(listed.documents.map(d => [d.path, d]));
    assert.equal(byPath.get("script.py")?.languageId, "python");
    assert.equal(byPath.get("notes.md")?.languageId, "markdown");
    assert.equal(byPath.get("notes.md")?.dirty, false);
  });
});

test("an unknown workspace is refused rather than served", async () => {
  await withBus(async ({ client }) => {
    await assert.rejects(
      client.listDocuments({ sessionId: "main", workspaceId: "not-main" }),
      (error: any) => error.code === "WORKSPACE_NOT_FOUND"
    );
  });
});

test("two agents on one bus see each other's files", async () => {
  const box = sandbox();
  const second = { id: "agent-b", token: "token-b-0123456789abcdef" };
  const bus = await startGuestBus({
    socketPath: box.socket, workspaceRoot: box.root, agents: [AGENT, second]
  });
  const a = await BusClient.connect({ socketPath: box.socket, agent: { id: AGENT.id, token: AGENT.token } });
  const b = await BusClient.connect({ socketPath: box.socket, agent: { id: second.id, token: second.token } });
  try {
    await create(a, "from-a.txt", "written by a");
    const seenByB = await b.readDocument({
      sessionId: "main", workspaceId: WORKSPACE_ID, path: "from-a.txt"
    });
    assert.equal(seenByB.document.text, "written by a");
    // And the file is on the shared disk, which is what the human's desktop sees.
    assert.equal(readFileSync(join(box.root, "from-a.txt"), "utf8"), "written by a");
  } finally {
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    await bus.close().catch(() => undefined);
    box.cleanup();
  }
});

test("the derived document version is stable for identical bytes", () => {
  const a = versionNumber("sha256:" + "ab".repeat(32));
  const b = versionNumber("sha256:" + "ab".repeat(32));
  const c = versionNumber("sha256:" + "cd".repeat(32));
  assert.equal(a, b, "identical content hashes to the same version");
  assert.notEqual(a, c, "different content hashes to different versions");
  assert.ok(a > 0 && Number.isSafeInteger(a));
});

test("languages are inferred from the extension and default safely", () => {
  assert.equal(languageOf("a/b.ts"), "typescript");
  assert.equal(languageOf("Makefile"), "plaintext");
  assert.equal(languageOf("weird.zzz"), "plaintext");
});
