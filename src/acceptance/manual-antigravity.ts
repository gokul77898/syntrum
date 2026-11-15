import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BusClient, type BusEvent } from "../bus/index.js";
import {
  ANTIGRAVITY_IDE_PROFILE,
  DualHeadRuntime,
  type AgentCredentials
} from "../integration/index.js";

async function mcpClient(credentials: AgentCredentials): Promise<Client> {
  const client = new Client(
    { name: `manual-${credentials.agentId}`, version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(new StdioClientTransport({
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
  }));
  return client;
}

function documentOf(response: Record<string, any>) {
  if (response.isError) {
    throw new Error(JSON.stringify(response.structuredContent));
  }
  return response.structuredContent.document as { text: string; version: number };
}

async function readDocument(client: Client) {
  return documentOf(await client.callTool({
    name: "document_read",
    arguments: { workspaceId: "main", path: "note.txt" }
  }) as Record<string, any>);
}

async function writeDocument(client: Client, text: string, expectedVersion: number) {
  return client.callTool({
    name: "document_write",
    arguments: { workspaceId: "main", path: "note.txt", text, expectedVersion }
  }) as Promise<Record<string, any>>;
}

async function main(): Promise<void> {
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-manual-"));
  let runtime = new DualHeadRuntime({ dataRoot, ide: ANTIGRAVITY_IDE_PROFILE });
  const clients: Client[] = [];
  const busClients: BusClient[] = [];
  const receivedEvents: BusEvent[] = [];
  const evidence: Record<string, unknown> = { status: "IMPLEMENTED" };
  let sessionId: string | undefined;
  let applicationId: string | undefined;
  let cleanupComplete = false;

  try {
    await runtime.start();
    const session = await runtime.createSession();
    sessionId = session.id;
    const resource = runtime.supervisor.getSessionResource(sessionId)!;
    const documentPath = join(resource.workspaceRoot, "note.txt");
    await writeFile(documentPath, "initial text\n");
    const launch = await runtime.launchIDE(sessionId);
    applicationId = launch.application.id;
    await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
    await runtime.waitForVSCode(sessionId);

    const credentialsA = await runtime.provisionAgent(sessionId, "manual-agent-a");
    const credentialsB = await runtime.provisionAgent(sessionId, "manual-agent-b");
    const agent1 = await mcpClient(credentialsA);
    const agent2 = await mcpClient(credentialsB);
    clients.push(agent1, agent2);
    const agent2Bus = await BusClient.connect({
      socketPath: credentialsB.busSocketPath,
      agent: { id: credentialsB.agentId, token: credentialsB.token }
    });
    busClients.push(agent2Bus);
    agent2Bus.onEvent(event => receivedEvents.push(event));
    await agent2Bus.subscribe({ sessionId, channel: "document.changed" });
    await agent2Bus.subscribe({ sessionId, channel: "document.saved" });

    const before = await readDocument(agent1);
    evidence.beforeHumanEdit = before;
    const controlPath = join(dataRoot, "continue");
    console.log(JSON.stringify({
      status: "WAITING_FOR_MANUAL_EDIT",
      applicationPid: launch.application.pid,
      workspace: resource.workspaceRoot,
      document: documentPath,
      before,
      instructions: [
        "In the isolated Antigravity window, complete Get Started if shown.",
        "Open note.txt, edit its contents, and save it in Antigravity.",
        `Then create the control file: touch ${controlPath}`
      ]
    }, null, 2));

    const deadline = Date.now() + 15 * 60_000;
    while (true) {
      try {
        await stat(controlPath);
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error("Manual edit timed out after 15 minutes");
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 500));
      }
    }

    const after = await readDocument(agent1);
    if (after.text === before.text || after.version <= before.version) {
      throw new Error(`Manual edit was not visible through MCP: ${JSON.stringify(after)}`);
    }
    evidence.afterHumanEdit = after;

    const eventDeadline = Date.now() + 10_000;
    while (
      !receivedEvents.some(event => event.channel === "document.changed") &&
      Date.now() < eventDeadline
    ) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    const changed = receivedEvents.find(event => event.channel === "document.changed");
    const saved = receivedEvents.find(event => event.channel === "document.saved");
    if (!changed) {
      throw new Error("Agent 2 did not receive the real document.changed event");
    }
    const eventData = changed.data as any;
    if (eventData.origin !== null) {
      throw new Error(`Human event has incorrect origin: ${JSON.stringify(eventData)}`);
    }
    evidence.agent2Event = { changed: changed.data, saved: saved?.data ?? null };

    const focusBefore = await runtime.supervisor.frontmostApplication();
    const writes = await Promise.all([
      writeDocument(agent1, "agent 1 concurrent write", after.version),
      writeDocument(agent2, "agent 2 concurrent write", after.version)
    ]);
    const winnerIndex = writes.findIndex(response => response.isError !== true);
    const loserIndex = writes.findIndex(response => response.isError === true);
    if (winnerIndex === -1 || loserIndex === -1) {
      throw new Error(`Concurrent writes did not produce one winner: ${JSON.stringify(writes)}`);
    }
    const conflict = writes[loserIndex].structuredContent.error;
    if (conflict.code !== "VERSION_CONFLICT") {
      throw new Error(`Losing write did not return VERSION_CONFLICT: ${JSON.stringify(conflict)}`);
    }
    const losingAgent = loserIndex === 0 ? agent1 : agent2;
    const losingName = loserIndex === 0 ? "manual-agent-a" : "manual-agent-b";
    const current = await readDocument(losingAgent);
    const retry = await writeDocument(
      losingAgent,
      `${current.text}\n${losingName} retry`,
      current.version
    );
    if (retry.isError) {
      throw new Error(`Losing agent retry failed: ${JSON.stringify(retry)}`);
    }
    const focusAfter = await runtime.supervisor.frontmostApplication();
    if (focusBefore.pid !== focusAfter.pid || focusBefore.launchDate !== focusAfter.launchDate) {
      throw new Error("Agent operations changed the frontmost application");
    }
    evidence.concurrentWrites = {
      winner: loserIndex === 0 ? "manual-agent-b" : "manual-agent-a",
      loser: losingName,
      conflict,
      retry: retry.structuredContent.document,
      frontmostPidUnchanged: focusAfter.pid
    };

    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(busClients.splice(0).map(client => client.close()));
    await runtime.close();
    runtime = new DualHeadRuntime({ dataRoot, ide: ANTIGRAVITY_IDE_PROFILE });
    await runtime.start();
    const restored = runtime.supervisor.getSession(sessionId);
    const application = restored.applications.find(item => item.id === applicationId);
    if (!application || application.status !== "running" || application.processIdentity !== "verified") {
      throw new Error("Antigravity did not reconcile after supervisor restart");
    }
    await runtime.waitForVSCode(sessionId);
    const restartedAgent = await mcpClient(credentialsA);
    clients.push(restartedAgent);
    evidence.restart = {
      sessionPersisted: true,
      applicationStatus: application.status,
      processIdentity: application.processIdentity,
      document: await readDocument(restartedAgent)
    };
    evidence.status = "VERIFIED";

    await runtime.supervisor.terminateApplication(sessionId, applicationId);
    applicationId = undefined;
    await Promise.all(clients.splice(0).map(client => client.close()));
    await runtime.close();
    await rm(dataRoot, { recursive: true, force: true });
    cleanupComplete = true;
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.temporaryDataRoot = dataRoot;
    console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } finally {
    if (!cleanupComplete) {
      await Promise.allSettled(clients.map(client => client.close()));
      await Promise.allSettled(busClients.map(client => client.close()));
      if (sessionId) {
        const applications = runtime.supervisor.getSession(sessionId).applications;
        for (const application of applications) {
          if (application.processOrigin === "launched" && application.status !== "exited") {
            await runtime.supervisor.terminateApplication(sessionId, application.id).catch(() => undefined);
          }
        }
      }
      await runtime.close().catch(() => undefined);
      console.error(`Temporary Antigravity profile retained for inspection: ${dataRoot}`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
