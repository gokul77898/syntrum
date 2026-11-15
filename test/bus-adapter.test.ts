import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BusClient,
  BusError,
  BusServer,
  type ConnectionGrant
} from "../src/bus/index.js";
import {
  DocumentConflictError,
  type AdapterEvent,
  type AgentIdentity,
  type ApplicationAdapter,
  type DocumentSnapshot,
  type EventPage,
  type ReadEventsOptions,
  type WriteDocumentOptions
} from "../src/adapters/index.js";
import { BusApplicationAdapter } from "../src/mcp/index.js";

class SharedAdapter implements ApplicationAdapter {
  readonly application = "vscode";
  readonly agents: string[] = [];
  delayReadMs = 0;
  private version = 1;
  private text = "initial";
  private readonly events: AdapterEvent[] = [];

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async listWorkspaces(agent: AgentIdentity) {
    this.agents.push(agent.agentId);
    return [{ id: "main", name: "Main", connected: true }];
  }

  async listDocuments(agent: AgentIdentity) {
    this.agents.push(agent.agentId);
    return [this.snapshot()];
  }

  async readDocument(agent: AgentIdentity): Promise<DocumentSnapshot> {
    this.agents.push(agent.agentId);
    if (this.delayReadMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayReadMs));
    }
    return this.snapshot();
  }

  async writeDocument(
    agent: AgentIdentity,
    _workspaceId: string,
    _path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot> {
    this.agents.push(agent.agentId);
    if (options.expectedVersion !== this.version) {
      throw new DocumentConflictError(this.snapshot());
    }
    this.text = text;
    this.version += 1;
    this.events.push({
      id: this.events.length + 1,
      type: "document.changed",
      workspaceId: "main",
      path: "note.txt",
      version: this.version,
      dirty: true,
      timestamp: new Date().toISOString(),
      origin: agent
    });
    return this.snapshot();
  }

  async getEvents(_agent: AgentIdentity, options: ReadEventsOptions = {}): Promise<EventPage> {
    const events = this.events.filter(event => event.id > (options.after ?? 0));
    return {
      events: events.slice(0, options.limit ?? 100),
      nextEventId: events.at(-1)?.id ?? options.after ?? 0,
      oldestEventId: this.events[0]?.id ?? 0,
      reset: false
    };
  }

  onEvent(): () => void {
    return () => undefined;
  }

  private snapshot(): DocumentSnapshot {
    return {
      workspaceId: "main",
      path: "note.txt",
      text: this.text,
      version: this.version,
      languageId: "plaintext",
      dirty: true,
      eol: "lf"
    };
  }
}

const grants: Record<string, ConnectionGrant> = {
  "agent-a": {
    capabilities: [
      "adapter:workspace:list",
      "adapter:document:list",
      "adapter:document:read",
      "adapter:document:write",
      "adapter:events:read"
    ],
    sessionIds: ["session-a"]
  },
  "agent-b": {
    capabilities: [
      "adapter:workspace:list",
      "adapter:document:list",
      "adapter:document:read",
      "adapter:document:write",
      "adapter:events:read"
    ],
    sessionIds: ["session-a"]
  }
};

async function harness(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cloud-ai-bus-adapter-"));
  const adapter = new SharedAdapter();
  const server = new BusServer({
    socketPath: join(directory, "bus.sock"),
    authorize: identity => identity.token === "secret" ? grants[identity.id] ?? null : null,
    adapterResolver: sessionId => sessionId === "session-a" ? adapter : undefined
  });
  await server.registerSession("session-a", directory);
  await server.listen();
  const clients: BusClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    adapter,
    connect: async (agentId: string, requestTimeoutMs = 1000) => {
      const client = await BusClient.connect({
        socketPath: server.socketPath,
        agent: { id: agentId, token: "secret" },
        requestTimeoutMs
      });
      clients.push(client);
      return client;
    }
  };
}

test("two real UDS agents share one adapter and stale writes lose cleanly", async t => {
  const { adapter, connect } = await harness(t);
  const clientA = await connect("agent-a");
  const clientB = await connect("agent-b");
  const agentA = new BusApplicationAdapter(clientA);
  const agentB = new BusApplicationAdapter(clientB);
  const identityA = { agentId: "agent-a", sessionId: "session-a" };
  const identityB = { agentId: "agent-b", sessionId: "session-a" };

  const initial = await agentA.readDocument(identityA, "main", "note.txt");
  const results = await Promise.allSettled([
    agentA.writeDocument(identityA, "main", "note.txt", "from A", {
      expectedVersion: initial.version
    }),
    agentB.writeDocument(identityB, "main", "note.txt", "from B", {
      expectedVersion: initial.version
    })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected);
  assert.ok(rejected.reason instanceof DocumentConflictError);

  const current = await agentB.readDocument(identityB, "main", "note.txt");
  assert.match(current.text, /^from [AB]$/);
  const events = await agentA.getEvents(identityA);
  assert.equal(events.events.length, 1);
  assert.match(events.events[0].origin?.agentId ?? "", /^agent-[ab]$/);
  assert.ok(adapter.agents.includes("agent-a"));
  assert.ok(adapter.agents.includes("agent-b"));

  await assert.rejects(
    new BusApplicationAdapter(clientA).readDocument(identityB, "main", "note.txt"),
    /does not match/
  );
  await assert.rejects(
    clientA.readDocument({ sessionId: "session-b", workspaceId: "main", path: "note.txt" }),
    (error: unknown) => error instanceof BusError && error.code === "SESSION_FORBIDDEN"
  );
});

test("a timed-out request's late response does not disconnect the bus client", async t => {
  const { adapter, connect } = await harness(t);
  const client = await connect("agent-a", 20);
  adapter.delayReadMs = 60;
  await assert.rejects(
    client.readDocument({ sessionId: "session-a", workspaceId: "main", path: "note.txt" }),
    (error: unknown) => error instanceof BusError && error.code === "REQUEST_TIMEOUT"
  );
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(client.isConnected, true);
  assert.ok((await client.ping()).now);
});
