import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  AdapterEvent,
  AgentIdentity,
  ApplicationAdapter,
  DocumentConflictError,
  DocumentDescriptor,
  DocumentSnapshot,
  EventPage,
  ReadEventsOptions,
  WorkspaceInfo,
  WriteDocumentOptions
} from "../src/adapters/index.js";
import {
  AdapterPermission,
  AgentAccess,
  createAdapterMcpServer
} from "../src/mcp/index.js";

class FakeAdapter implements ApplicationAdapter {
  readonly application = "vscode";
  readonly calls: Array<{ operation: string; agent: AgentIdentity }> = [];
  text = "one";
  version = 1;

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async listWorkspaces(agent: AgentIdentity): Promise<WorkspaceInfo[]> {
    this.calls.push({ operation: "workspace_list", agent });
    return [
      { id: "allowed", name: "Allowed", connected: true },
      { id: "other", name: "Other", connected: true }
    ];
  }

  async listDocuments(agent: AgentIdentity): Promise<DocumentDescriptor[]> {
    this.calls.push({ operation: "document_list", agent });
    return [this.snapshot()];
  }

  async readDocument(agent: AgentIdentity): Promise<DocumentSnapshot> {
    this.calls.push({ operation: "document_read", agent });
    return this.snapshot();
  }

  async writeDocument(
    agent: AgentIdentity,
    _workspaceId: string,
    _path: string,
    text: string,
    options: WriteDocumentOptions
  ): Promise<DocumentSnapshot> {
    this.calls.push({ operation: "document_write", agent });
    if (options.expectedVersion !== this.version) {
      throw new DocumentConflictError(this.snapshot());
    }
    this.text = text;
    this.version += 1;
    return this.snapshot();
  }

  async getEvents(agent: AgentIdentity, options: ReadEventsOptions = {}): Promise<EventPage> {
    this.calls.push({ operation: "events_read", agent });
    const events: AdapterEvent[] = [{
      id: 1,
      type: "document.changed",
      workspaceId: "allowed",
      path: "note.txt",
      version: this.version,
      dirty: true,
      timestamp: new Date(0).toISOString(),
      origin: agent
    }, {
      id: 2,
      type: "document.changed",
      workspaceId: "other",
      path: "private.txt",
      version: this.version,
      dirty: true,
      timestamp: new Date(0).toISOString(),
      origin: agent
    }];
    return {
      events: events.filter(event => event.id > (options.after ?? 0)),
      nextEventId: 2,
      oldestEventId: 1,
      reset: false
    };
  }

  onEvent(): () => void {
    return () => {};
  }

  private snapshot(): DocumentSnapshot {
    return {
      workspaceId: "allowed",
      path: "note.txt",
      text: this.text,
      version: this.version,
      languageId: "plaintext",
      dirty: false,
      eol: "lf"
    };
  }
}

function access(
  agentId: string,
  permissions: AdapterPermission[],
  workspaceIds = ["allowed"]
): AgentAccess {
  return {
    identity: { agentId, sessionId: "session-1" },
    permissions: new Set(permissions),
    workspaceIds: new Set(workspaceIds)
  };
}

async function connectedClient(t: test.TestContext, adapter: FakeAdapter, agent: AgentAccess) {
  const server = createAdapterMcpServer(adapter, agent);
  const client = new Client(
    { name: `test-${agent.identity.agentId}`, version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  return { client, server };
}

test("MCP lists only explicitly permitted constrained tools", async t => {
  const adapter = new FakeAdapter();
  const { client } = await connectedClient(
    t,
    adapter,
    access("reader", ["workspace:list", "document:read", "events:read"])
  );
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(tool => tool.name),
    ["workspace_list", "document_read", "events_read"]
  );

  const result = await client.callTool({
    name: "workspace_list",
    arguments: {}
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    workspaces: [{ id: "allowed", name: "Allowed", connected: true }]
  });
  assert.equal(adapter.calls[0].agent.agentId, "reader");
});

test("MCP serves concurrent identity-bound clients without identity spoofing", async t => {
  const adapter = new FakeAdapter();
  const reader = await connectedClient(
    t,
    adapter,
    access("reader", ["document:read", "events:read"])
  );
  const writer = await connectedClient(
    t,
    adapter,
    access("writer", ["document:write", "events:read"])
  );

  const [readResult, writeResult] = await Promise.all([
    reader.client.callTool({
      name: "document_read",
      arguments: { workspaceId: "allowed", path: "note.txt" }
    }),
    writer.client.callTool({
      name: "document_write",
      arguments: {
        workspaceId: "allowed",
        path: "note.txt",
        text: "written by writer",
        expectedVersion: 1
      }
    })
  ]);
  assert.equal(readResult.isError, undefined);
  assert.equal(writeResult.isError, undefined);

  const readCall = adapter.calls.find(call => call.operation === "document_read");
  const writeCall = adapter.calls.find(call => call.operation === "document_write");
  assert.equal(readCall?.agent.agentId, "reader");
  assert.equal(writeCall?.agent.agentId, "writer");
  assert.equal(adapter.text, "written by writer");

  const [readerEvents, writerEvents] = await Promise.all([
    reader.client.callTool({ name: "events_read", arguments: { after: 0 } }),
    writer.client.callTool({ name: "events_read", arguments: { after: 0 } })
  ]);
  assert.equal(readerEvents.isError, undefined);
  assert.equal(writerEvents.isError, undefined);
});

test("MCP denies workspace access and operations outside the agent policy", async t => {
  const adapter = new FakeAdapter();
  const { client } = await connectedClient(
    t,
    adapter,
    access("restricted", ["document:read"])
  );
  const workspaceDenied = await client.callTool({
    name: "document_read",
    arguments: { workspaceId: "other", path: "note.txt" }
  });
  assert.equal(workspaceDenied.isError, true);
  assert.equal(
    (workspaceDenied.structuredContent as any).error.code,
    "WORKSPACE_DENIED"
  );

  const permissionDenied = await client.callTool({
    name: "document_write",
    arguments: {
      workspaceId: "allowed",
      path: "note.txt",
      text: "not allowed",
      expectedVersion: 1
    }
  });
  assert.equal(permissionDenied.isError, true);
  assert.equal(
    (permissionDenied.structuredContent as any).error.code,
    "PERMISSION_DENIED"
  );
  assert.equal(adapter.calls.length, 0);
});

test("MCP returns conflicts as structured errors and validates arguments", async t => {
  const adapter = new FakeAdapter();
  const { client } = await connectedClient(
    t,
    adapter,
    access("writer", ["document:write"])
  );
  const conflict = await client.callTool({
    name: "document_write",
    arguments: {
      workspaceId: "allowed",
      path: "note.txt",
      text: "stale",
      expectedVersion: 99
    }
  });
  assert.equal(conflict.isError, true);
  const conflictBody = conflict.structuredContent as any;
  assert.equal(conflictBody.error.code, "VERSION_CONFLICT");
  assert.equal(conflictBody.error.details.current.version, 1);

  const invalid = await client.callTool({
    name: "document_write",
    arguments: {
      workspaceId: "allowed",
      path: "note.txt",
      text: "unexpected field",
      expectedVersion: 1,
      recursive: true
    }
  });
  assert.equal(invalid.isError, true);
  assert.equal((invalid.structuredContent as any).error.code, "INVALID_ARGUMENTS");
});


test("MCP events_read never leaks another allowed adapter workspace", async t => {
  const adapter = new FakeAdapter();
  const { client } = await connectedClient(
    t,
    adapter,
    access("reader", ["events:read"], ["allowed"])
  );
  const response = await client.callTool({ name: "events_read", arguments: {} });
  assert.equal(response.isError, undefined);
  const body = response.structuredContent as any;
  assert.deepEqual(body.events.map((event: any) => event.path), ["note.txt"]);
  assert.equal(body.events.some((event: any) => event.workspaceId === "other"), false);
});
