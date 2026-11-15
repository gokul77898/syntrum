import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { DualHeadRuntime, type AgentCredentials } from "../src/integration/index.js";
import type { NativeManager, NativeResult } from "../src/runtime/index.js";
import { MockExtension } from "./helpers/mock-extension.js";

class IntegrationNativeManager implements NativeManager {
  readonly launchOptions: unknown[] = [];

  async launch(bundleIdentifier: string, options?: unknown): Promise<NativeResult> {
    this.launchOptions.push(options);
    return {
      ok: true,
      pid: 4242,
      name: "Visual Studio Code",
      bundleIdentifier,
      bundleURL: "/Applications/Visual Studio Code.app",
      launchDate: "2026-01-01T00:00:00.000Z",
      processExistedBeforeLaunch: false,
      processReused: false
    };
  }

  async inspect(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    return {
      ok: true,
      pid,
      bundleIdentifier,
      launchDate: "2026-01-01T00:00:00.000Z",
      running: true
    };
  }

  async terminate(pid: number): Promise<NativeResult> {
    return { ok: true, pid, running: false, terminationRequested: true };
  }

  async frontmost(): Promise<NativeResult> {
    return { ok: true, available: true, pid: 1, bundleIdentifier: "com.example.Frontmost" };
  }
}

async function mcpClient(credentials: AgentCredentials) {
  const client = new Client(
    { name: `integration-${credentials.agentId}`, version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    env: {
      ...process.env,
      CLOUD_AI_OS_BUS_SOCKET: credentials.busSocketPath,
      CLOUD_AI_OS_AGENT_ID: credentials.agentId,
      CLOUD_AI_OS_AGENT_TOKEN: credentials.token,
      CLOUD_AI_OS_SESSION_ID: credentials.sessionId,
      CLOUD_AI_OS_MCP_WORKSPACES: "main",
      CLOUD_AI_OS_MCP_PERMISSIONS: "workspace:list,document:list,document:read,document:write,events:read"
    } as Record<string, string>
  });
  await client.connect(transport);
  return client;
}

function documentOf(response: Record<string, any>) {
  return response.structuredContent.document as {
    text: string;
    version: number;
    dirty: boolean;
  };
}

test("integrated SQLite + UDS + real MCP stdio agents survive a runtime restart", async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cloud-ai-os-integration-"));
  const native = new IntegrationNativeManager();
  let runtime = new DualHeadRuntime({ dataRoot, nativeManager: native, pollIntervalMs: 0 });
  const clients: Client[] = [];
  let extension: MockExtension | undefined;
  t.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    extension?.close();
    await runtime.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  await runtime.start();
  const session = await runtime.createSession();
  const resource = runtime.supervisor.getSessionResource(session.id)!;
  await writeFile(join(resource.workspaceRoot, "note.txt"), "initial text");
  extension = new MockExtension(
    resource.adapterSocketPath,
    resource.adapterToken,
    resource.workspaceRoot
  );
  await extension.connect();
  assert.equal(runtime.readiness(session.id).extensionConnected, true);

  const credentialsA = await runtime.provisionAgent(session.id, "integration-a");
  const credentialsB = await runtime.provisionAgent(session.id, "integration-b");
  const clientA = await mcpClient(credentialsA);
  const clientB = await mcpClient(credentialsB);
  clients.push(clientA, clientB);

  const initial = await clientA.callTool({
    name: "document_read",
    arguments: { workspaceId: "main", path: "note.txt" }
  }) as Record<string, any>;
  const initialDocument = documentOf(initial);
  assert.equal(initialDocument.text, "initial text");

  const writes = await Promise.all([
    clientA.callTool({
      name: "document_write",
      arguments: {
        workspaceId: "main",
        path: "note.txt",
        text: "written by A",
        expectedVersion: initialDocument.version
      }
    }),
    clientB.callTool({
      name: "document_write",
      arguments: {
        workspaceId: "main",
        path: "note.txt",
        text: "written by B",
        expectedVersion: initialDocument.version
      }
    })
  ]) as Record<string, any>[];
  assert.equal(writes.filter(response => response.isError !== true).length, 1);
  const conflict = writes.find(response => response.isError === true)!;
  assert.equal(conflict.structuredContent.error.code, "VERSION_CONFLICT");
  const winner = writes.find(response => response.isError !== true)!;
  const winnerText = documentOf(winner).text;

  const events = await clientB.callTool({
    name: "events_read",
    arguments: { after: 0, limit: 200 }
  }) as Record<string, any>;
  assert.equal(events.structuredContent.reset, false);
  assert.ok(events.structuredContent.events.some(
    (event: any) => event.type === "document.changed" && event.origin !== null
  ));
  const cursor = events.structuredContent.nextEventId as number;

  await Promise.all([clientA.close(), clientB.close()]);
  clients.length = 0;
  await runtime.close();
  extension.close();

  runtime = new DualHeadRuntime({ dataRoot, nativeManager: native, pollIntervalMs: 0 });
  await runtime.start();
  assert.equal(runtime.supervisor.getSession(session.id).id, session.id);
  assert.equal(runtime.readiness(session.id).adapterStarted, true);
  assert.equal(runtime.readiness(session.id).extensionConnected, false);
  const restoredResource = runtime.supervisor.getSessionResource(session.id)!;
  assert.equal(restoredResource.adapterToken, resource.adapterToken);
  assert.equal(restoredResource.adapterSocketPath, resource.adapterSocketPath);
  await extension.connect();
  assert.equal(runtime.readiness(session.id).extensionConnected, true);

  const restartedA = await mcpClient(credentialsA);
  const restartedB = await mcpClient(credentialsB);
  clients.push(restartedA, restartedB);
  const restored = await restartedA.callTool({
    name: "document_read",
    arguments: { workspaceId: "main", path: "note.txt" }
  }) as Record<string, any>;
  assert.equal(documentOf(restored).text, winnerText);

  const durableEvents = await restartedB.callTool({
    name: "events_read",
    arguments: { after: cursor, limit: 200 }
  }) as Record<string, any>;
  assert.equal(durableEvents.structuredContent.reset, false);
  assert.equal(durableEvents.structuredContent.events.length, 1);
  assert.equal(durableEvents.structuredContent.events[0].type, "document.opened");
  const restartCursor = durableEvents.structuredContent.nextEventId as number;
  assert.ok(restartCursor > cursor);

  const afterRestart = await restartedA.callTool({
    name: "document_write",
    arguments: {
      workspaceId: "main",
      path: "note.txt",
      text: "written after restart",
      expectedVersion: documentOf(restored).version
    }
  }) as Record<string, any>;
  assert.equal(afterRestart.isError, undefined);
  assert.equal(documentOf(afterRestart).text, "written after restart");

  const newEvents = await restartedB.callTool({
    name: "events_read",
    arguments: { after: restartCursor, limit: 200 }
  }) as Record<string, any>;
  assert.ok(newEvents.structuredContent.events.some(
    (event: any) => event.type === "document.changed" &&
      event.origin?.agentId === "integration-a"
  ));
  assert.ok(newEvents.structuredContent.nextEventId > restartCursor);
});


test("HTTP provisions dual-head resources and uses only typed VS Code launch configuration", async t => {
  const [{ once }, { createRuntimeHttpServer }, { BusClient }] = await Promise.all([
    import("node:events"),
    import("../src/server.js"),
    import("../src/bus/index.js")
  ]);
  const dataRoot = await mkdtemp(join(tmpdir(), "cloud-ai-os-http-integration-"));
  const native = new IntegrationNativeManager();
  const runtime = new DualHeadRuntime({ dataRoot, nativeManager: native, pollIntervalMs: 0 });
  let extension: MockExtension | undefined;
  let client: InstanceType<typeof BusClient> | undefined;
  await runtime.start();
  const server = createRuntimeHttpServer(runtime.supervisor, { dualHead: runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await client?.close();
    extension?.close();
    server.close();
    await once(server, "close");
    await runtime.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  const createdResponse = await fetch(`${base}/sessions`, { method: "POST" });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as any;
  const sessionId = created.session.id as string;
  const resource = runtime.supervisor.getSessionResource(sessionId)!;
  await writeFile(join(resource.workspaceRoot, "note.txt"), "initial text");

  const readinessResponse = await fetch(`${base}/sessions/${sessionId}/dual-head`);
  const readiness = await readinessResponse.json() as any;
  assert.equal(readiness.adapterStarted, true);
  assert.equal(readiness.extensionConnected, false);

  const agentResponse = await fetch(`${base}/sessions/${sessionId}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "http-agent" })
  });
  assert.equal(agentResponse.status, 201);
  const agentBody = await agentResponse.json() as any;
  const credentials = agentBody.agent as AgentCredentials;
  assert.ok(credentials.token);
  assert.equal((await stat(credentials.busSocketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataRoot, "runtime.sqlite"))).mode & 0o777, 0o600);
  const sessionsText = await (await fetch(`${base}/sessions`)).text();
  assert.equal(sessionsText.includes(credentials.token), false);

  client = await BusClient.connect({
    socketPath: credentials.busSocketPath,
    agent: { id: credentials.agentId, token: credentials.token }
  });
  const workspaces = await client.listWorkspaces({ sessionId });
  assert.deepEqual(workspaces.workspaces, [
    { id: "main", name: "main", connected: false }
  ]);

  extension = new MockExtension(
    resource.adapterSocketPath,
    resource.adapterToken,
    resource.workspaceRoot
  );
  await extension.connect();
  const launchResponse = await fetch(`${base}/sessions/${sessionId}/vscode`, {
    method: "POST"
  });
  assert.equal(launchResponse.status, 201);
  const launchBody = await launchResponse.json() as any;
  assert.equal(launchBody.application.bundleIdentifier, "com.microsoft.VSCode");
  assert.equal(launchBody.application.processOrigin, "launched");
  const options = native.launchOptions[0] as any;
  assert.equal(options.activates, false);
  assert.equal(options.workspacePath, resource.workspaceRoot);
  assert.ok(options.arguments.includes("--extensionDevelopmentPath"));
  assert.equal(options.environment.CLOUD_AI_OS_VSCODE_TOKEN, resource.adapterToken);
  assert.equal(runtime.readiness(sessionId).extensionConnected, true);
});
