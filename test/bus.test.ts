import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  BUS_CAPABILITIES,
  BUS_PROTOCOL_VERSION,
  BusClient,
  BusError,
  BusServer,
  type BusServerOptions,
  type ConnectionGrant
} from "../src/bus/index.js";

const ALL_CAPABILITIES = [...BUS_CAPABILITIES];
const GRANTS: Record<string, ConnectionGrant> = {
  fullA: { capabilities: ALL_CAPABILITIES, sessionIds: ["session-a"] },
  fullB: { capabilities: ALL_CAPABILITIES, sessionIds: ["session-b"] },
  reader: {
    capabilities: ["workspace:read", "workspace:list"],
    sessionIds: ["session-a"]
  },
  writer: {
    capabilities: ["workspace:read", "workspace:write", "workspace:list"],
    sessionIds: ["session-a"]
  }
};

type Harness = {
  server: BusServer;
  rootA: string;
  rootB: string;
  temporaryDirectory: string;
  connect: (agentId?: string) => Promise<BusClient>;
};

async function createHarness(
  t: TestContext,
  options: Partial<BusServerOptions> = {}
): Promise<Harness> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-bus-"));
  const rootA = join(temporaryDirectory, "workspace-a");
  const rootB = join(temporaryDirectory, "workspace-b");
  await Promise.all([
    mkdir(rootA, { recursive: true }),
    mkdir(rootB, { recursive: true })
  ]);

  const server = new BusServer({
    socketPath: join(temporaryDirectory, "bus.sock"),
    authorize: identity => identity.token === "test-secret"
      ? GRANTS[identity.id] ?? null
      : null,
    ...options
  });
  await server.registerSession("session-a", rootA);
  await server.registerSession("session-b", rootB);
  await server.listen();

  const clients: BusClient[] = [];
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  return {
    server,
    rootA,
    rootB,
    temporaryDirectory,
    connect: async (agentId = "fullA") => {
      const client = await BusClient.connect({
        socketPath: server.socketPath,
        agent: { id: agentId, token: "test-secret" }
      });
      clients.push(client);
      return client;
    }
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => {
    assert(error instanceof BusError, `Expected BusError, received ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

class RawPeer {
  private readonly queued: Record<string, unknown>[] = [];
  private readonly waiting: Array<(message: Record<string, unknown>) => void> = [];
  private buffered = "";

  private constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      this.buffered += chunk;
      let newline = this.buffered.indexOf("\n");
      while (newline !== -1) {
        const message = JSON.parse(this.buffered.slice(0, newline)) as Record<string, unknown>;
        this.buffered = this.buffered.slice(newline + 1);
        const waiter = this.waiting.shift();
        if (waiter === undefined) {
          this.queued.push(message);
        } else {
          waiter(message);
        }
        newline = this.buffered.indexOf("\n");
      }
    });
  }

  static async connect(socketPath: string): Promise<RawPeer> {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });
    return new RawPeer(socket);
  }

  send(message: unknown): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  hello(agentId = "fullA", maxFrameBytes = 4096): void {
    this.send({
      version: BUS_PROTOCOL_VERSION,
      type: "hello",
      agent: { id: agentId, token: "test-secret" },
      maxFrameBytes
    });
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise(resolveMessage => this.waiting.push(resolveMessage));
  }

  close(): void {
    this.socket.destroy();
  }
}

test("hello negotiates explicit identity, grants, and protocol version", async t => {
  const harness = await createHarness(t);
  const client = await harness.connect("reader");

  assert.equal(client.agentId, "reader");
  assert.deepEqual(client.capabilities, ["workspace:read", "workspace:list"]);
  assert.deepEqual(client.sessionIds, ["session-a"]);
  assert.equal(typeof (await client.ping()).now, "string");
  assert.equal(harness.server.getConnections()[0]?.agentId, "reader");

  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "denied.txt",
      content: "no"
    }),
    hasCode("CAPABILITY_DENIED")
  );
  await assert.rejects(
    client.listFiles({ sessionId: "session-b" }),
    hasCode("SESSION_FORBIDDEN")
  );
  await assert.rejects(
    BusClient.connect({
      socketPath: harness.server.socketPath,
      agent: { id: "reader", token: "wrong" }
    }),
    hasCode("AUTH_FAILED")
  );
  await assert.rejects(harness.connect("unknown"), hasCode("AUTH_FAILED"));
});

test("raw NDJSON supports fragmented and coalesced frames and rejects bad versions", async t => {
  const harness = await createHarness(t);
  const peer = await RawPeer.connect(harness.server.socketPath);
  t.after(() => peer.close());

  const hello = `${JSON.stringify({
    version: BUS_PROTOCOL_VERSION,
    type: "hello",
    agent: { id: "fullA", token: "test-secret" },
    maxFrameBytes: 4096
  })}\n`;
  const ping = `${JSON.stringify({
    version: BUS_PROTOCOL_VERSION,
    type: "request",
    id: "ping-1",
    method: "ping",
    params: {}
  })}\n`;

  peer.socket.write(hello.slice(0, 17));
  peer.socket.write(hello.slice(17));
  const welcome = await peer.next();
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.version, BUS_PROTOCOL_VERSION);

  peer.socket.write(`${ping}${ping.replace("ping-1", "ping-2")}`);
  const responses = [await peer.next(), await peer.next()];
  assert.deepEqual(
    responses.map(response => response.id).sort(),
    ["ping-1", "ping-2"]
  );
  assert(responses.every(response => response.ok === true));

  peer.send({
    version: BUS_PROTOCOL_VERSION,
    type: "request",
    id: "unknown-method",
    method: "system.shell",
    params: {}
  });
  const unknownMethod = await peer.next();
  assert.equal(unknownMethod.ok, false);
  assert.equal((unknownMethod.error as { code: string }).code, "METHOD_NOT_FOUND");

  const wrongVersion = await RawPeer.connect(harness.server.socketPath);
  t.after(() => wrongVersion.close());
  wrongVersion.send({ version: 999, type: "hello", agent: { id: "fullA" } });
  const rejection = await wrongVersion.next();
  assert.equal(rejection.type, "error");
  assert.equal((rejection.error as { code: string }).code, "VERSION_MISMATCH");
});

test("frame and file size limits are enforced on both client and server", async t => {
  const harness = await createHarness(t, { maxFrameBytes: 1024, maxFileBytes: 32 });
  const client = await BusClient.connect({
    socketPath: harness.server.socketPath,
    agent: { id: "fullA", token: "test-secret" },
    maxFrameBytes: 1024
  });
  t.after(() => client.close());

  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "too-large-frame.txt",
      content: "x".repeat(2000)
    }),
    hasCode("FRAME_TOO_LARGE")
  );
  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "too-large-file.txt",
      content: "x".repeat(33)
    }),
    hasCode("FILE_TOO_LARGE")
  );

  const peer = await RawPeer.connect(harness.server.socketPath);
  t.after(() => peer.close());
  peer.hello("fullA", 1024);
  assert.equal((await peer.next()).type, "welcome");
  peer.socket.write(`${"x".repeat(1100)}\n`);
  const oversized = await peer.next();
  assert.equal(oversized.type, "error");
  assert.equal((oversized.error as { code: string }).code, "FRAME_TOO_LARGE");
});

test("workspace reads, writes, base64, lists, and expected versions are real", async t => {
  const harness = await createHarness(t);
  const client = await harness.connect("fullA");
  await mkdir(join(harness.rootA, "notes"));

  const first = await client.writeFile({
    sessionId: "session-a",
    path: "notes/item.txt",
    content: "first",
    expectedVersion: null
  });
  assert.match(first.version, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.size, 5);

  const firstRead = await client.readFile({
    sessionId: "session-a",
    path: "notes/item.txt"
  });
  assert.equal(firstRead.content, "first");
  assert.equal(firstRead.version, first.version);

  const second = await client.writeFile({
    sessionId: "session-a",
    path: "notes/item.txt",
    content: "second",
    expectedVersion: first.version
  });
  assert.notEqual(second.version, first.version);
  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "notes/item.txt",
      content: "stale",
      expectedVersion: first.version
    }),
    error => {
      assert(error instanceof BusError);
      assert.equal(error.code, "VERSION_CONFLICT");
      assert.equal(error.details?.actualVersion, second.version);
      return true;
    }
  );
  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "notes/item.txt",
      content: "create-only",
      expectedVersion: null
    }),
    hasCode("VERSION_CONFLICT")
  );
  assert.equal(await readFile(join(harness.rootA, "notes/item.txt"), "utf8"), "second");

  const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
  await client.writeFile({
    sessionId: "session-a",
    path: "notes/binary.dat",
    content: binary.toString("base64"),
    encoding: "base64",
    expectedVersion: null
  });
  const binaryRead = await client.readFile({
    sessionId: "session-a",
    path: "notes/binary.dat",
    encoding: "base64"
  });
  assert.deepEqual(Buffer.from(binaryRead.content, "base64"), binary);

  const listing = await client.listFiles({ sessionId: "session-a", path: "notes" });
  assert.equal(listing.truncated, false);
  assert.deepEqual(
    listing.entries.map(entry => `${entry.path}:${entry.type}`),
    ["notes/binary.dat:file", "notes/item.txt:file"]
  );
  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "missing/child.txt",
      content: "no parent"
    }),
    hasCode("NOT_FOUND")
  );
});

test("workspace confinement rejects traversal, absolute paths, and symlinks", async t => {
  const harness = await createHarness(t);
  const client = await harness.connect("fullA");
  const outsideFile = join(harness.temporaryDirectory, "outside.txt");
  const outsideDirectory = join(harness.temporaryDirectory, "outside-directory");
  await writeFile(outsideFile, "outside secret");
  await mkdir(outsideDirectory);
  await symlink(outsideFile, join(harness.rootA, "file-link"));
  await symlink(outsideDirectory, join(harness.rootA, "directory-link"));

  for (const path of [
    "../outside.txt",
    outsideFile,
    "notes/../../outside.txt",
    "notes//item.txt",
    "notes/./item.txt",
    "C:\\outside.txt"
  ]) {
    await assert.rejects(
      client.readFile({ sessionId: "session-a", path }),
      hasCode("INVALID_PATH"),
      path
    );
  }
  await assert.rejects(
    client.readFile({ sessionId: "session-a", path: "file-link" }),
    hasCode("SYMLINK_NOT_ALLOWED")
  );
  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "directory-link/escape.txt",
      content: "escape"
    }),
    hasCode("SYMLINK_NOT_ALLOWED")
  );
  await assert.rejects(
    client.writeFile({
      sessionId: "session-a",
      path: "file-link",
      content: "overwrite"
    }),
    hasCode("SYMLINK_NOT_ALLOWED")
  );
  assert.equal(await readFile(outsideFile, "utf8"), "outside secret");

  const listing = await client.listFiles({ sessionId: "session-a" });
  assert.equal(
    listing.entries.find(entry => entry.name === "file-link")?.type,
    "symlink"
  );

  const otherClient = await harness.connect("fullB");
  await assert.rejects(
    otherClient.readFile({ sessionId: "session-a", path: "file-link" }),
    hasCode("SESSION_FORBIDDEN")
  );
});

test("concurrent expected-version writes have exactly one winner", async t => {
  const harness = await createHarness(t);
  const initializer = await harness.connect("fullA");
  const initial = await initializer.writeFile({
    sessionId: "session-a",
    path: "shared.txt",
    content: "initial",
    expectedVersion: null
  });
  const clients = await Promise.all(
    Array.from({ length: 20 }, () => harness.connect("fullA"))
  );

  const outcomes = await Promise.allSettled(clients.map((client, index) =>
    client.writeFile({
      sessionId: "session-a",
      path: "shared.txt",
      content: `writer-${index}`,
      expectedVersion: initial.version
    })
  ));
  const successful = outcomes.filter(outcome => outcome.status === "fulfilled");
  const conflicts = outcomes.filter(outcome =>
    outcome.status === "rejected" &&
    outcome.reason instanceof BusError &&
    outcome.reason.code === "VERSION_CONFLICT"
  );
  assert.equal(successful.length, 1);
  assert.equal(conflicts.length, clients.length - 1);

  const final = await initializer.readFile({
    sessionId: "session-a",
    path: "shared.txt"
  });
  assert.equal(final.version, successful[0]?.status === "fulfilled"
    ? successful[0].value.version
    : "unreachable");
  assert.match(final.content, /^writer-\d+$/);
});

test("events are isolated by session, channel, subscription, and capability", async t => {
  const harness = await createHarness(t);
  const publisher = await harness.connect("fullA");
  const allA = await harness.connect("fullA");
  const buildOnly = await harness.connect("fullA");
  const otherSession = await harness.connect("fullB");
  const reader = await harness.connect("reader");

  const allAEvents: unknown[] = [];
  const buildEvents: unknown[] = [];
  const otherEvents: unknown[] = [];
  allA.onEvent(event => allAEvents.push(event));
  buildOnly.onEvent(event => buildEvents.push(event));
  otherSession.onEvent(event => otherEvents.push(event));

  await allA.subscribe({ sessionId: "session-a" });
  const buildSubscription = await buildOnly.subscribe({
    sessionId: "session-a",
    channel: "build"
  });
  await otherSession.subscribe({ sessionId: "session-b" });

  const published = await publisher.publish({
    sessionId: "session-a",
    channel: "build",
    data: { status: "passed", attempt: 1 }
  });
  assert.equal(published.event.publisherId, "fullA");
  await Promise.all([allA.ping(), buildOnly.ping(), otherSession.ping()]);
  assert.equal(allAEvents.length, 1);
  assert.equal(buildEvents.length, 1);
  assert.equal(otherEvents.length, 0);

  await publisher.publish({
    sessionId: "session-a",
    channel: "chat",
    data: "hello"
  });
  await Promise.all([allA.ping(), buildOnly.ping()]);
  assert.equal(allAEvents.length, 2);
  assert.equal(buildEvents.length, 1);

  assert.equal((await buildOnly.unsubscribe(buildSubscription.subscriptionId)).removed, true);
  await publisher.publish({
    sessionId: "session-a",
    channel: "build",
    data: "after unsubscribe"
  });
  await Promise.all([allA.ping(), buildOnly.ping()]);
  assert.equal(allAEvents.length, 3);
  assert.equal(buildEvents.length, 1);

  await harness.server.publish("session-b", "build", { local: true });
  await Promise.all([allA.ping(), otherSession.ping()]);
  assert.equal(otherEvents.length, 1);
  assert.equal(allAEvents.length, 3);

  await assert.rejects(
    reader.publish({ sessionId: "session-a", channel: "build", data: null }),
    hasCode("CAPABILITY_DENIED")
  );
  await assert.rejects(
    reader.subscribe({ sessionId: "session-a" }),
    hasCode("CAPABILITY_DENIED")
  );
  await assert.rejects(
    publisher.publish({ sessionId: "session-b", channel: "build", data: null }),
    hasCode("SESSION_FORBIDDEN")
  );
});

test("multiple concurrent clients perform independent real operations", async t => {
  const harness = await createHarness(t);
  const clients = await Promise.all(
    Array.from({ length: 24 }, () => harness.connect("fullA"))
  );

  const results = await Promise.all(clients.map(async (client, index) => {
    const path = `client-${index}.txt`;
    const written = await client.writeFile({
      sessionId: "session-a",
      path,
      content: `content-${index}`,
      expectedVersion: null
    });
    const [read, listed, ping] = await Promise.all([
      client.readFile({ sessionId: "session-a", path }),
      client.listFiles({ sessionId: "session-a" }),
      client.ping()
    ]);
    return { index, written, read, listed, ping };
  }));

  assert.equal(results.length, 24);
  for (const result of results) {
    assert.equal(result.read.content, `content-${result.index}`);
    assert.equal(result.read.version, result.written.version);
    assert.equal(typeof result.ping.now, "string");
  }
  const finalListing = await clients[0]?.listFiles({ sessionId: "session-a" });
  assert.equal(finalListing?.entries.length, 24);
  assert.equal(harness.server.connectionCount, 24);
});
