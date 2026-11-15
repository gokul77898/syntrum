import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { runBenchmark, type BenchmarkResult } from "../benchmarks/index.js";
import {
  DualHeadRuntime,
  type AgentCredentials
} from "../integration/index.js";

const execFileAsync = promisify(execFile);

class BlockedAcceptance extends Error {}

async function mcpClient(credentials: AgentCredentials): Promise<Client> {
  const client = new Client(
    { name: `live-${credentials.agentId}`, version: "1.0.0" },
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

async function humanGuiEdit(): Promise<void> {
  const script = `
    tell application id "com.microsoft.VSCode" to activate
    delay 1
    tell application "System Events"
      keystroke "p" using command down
      delay 1
      keystroke "note.txt"
      key code 36
      delay 1
      keystroke "a" using command down
      keystroke "human edit from real GUI"
    end tell
  `;
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
  } catch (error) {
    throw new BlockedAcceptance(
      `Real GUI input requires macOS Accessibility permission for the terminal: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function documentOf(response: Record<string, any>) {
  if (response.isError) {
    throw new Error(JSON.stringify(response.structuredContent));
  }
  return response.structuredContent.document as { text: string; version: number };
}

async function main(): Promise<void> {
  const appPath = resolve(
    process.env.CLOUD_AI_OS_VSCODE_APP_PATH ?? "/Applications/Visual Studio Code.app"
  );
  try {
    await stat(appPath);
  } catch {
    console.log(JSON.stringify({
      status: "BLOCKED",
      reason: `Visual Studio Code is not installed at ${appPath}`,
      verified: "The non-live SQLite/UDS/MCP integration suite runs separately; no mock GUI result is substituted."
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const dataRoot = await mkdtemp(join(tmpdir(), "cloud-ai-os-live-acceptance-"));
  let runtime = new DualHeadRuntime({ dataRoot });
  const clients: Client[] = [];
  const evidence: Record<string, unknown> = { status: "IMPLEMENTED" };
  let sessionId: string | undefined;
  let applicationId: string | undefined;
  let cleanupComplete = false;

  try {
    await runtime.start();
    const session = await runtime.createSession();
    sessionId = session.id;
    const resource = runtime.supervisor.getSessionResource(sessionId)!;
    await writeFile(join(resource.workspaceRoot, "note.txt"), "initial text\n");
    const launch = await runtime.launchVSCode(sessionId);
    applicationId = launch.application.id;
    evidence.vscode = {
      pid: launch.application.pid,
      processOrigin: launch.application.processOrigin,
      processIdentity: launch.application.processIdentity
    };

    const credentialsA = await runtime.provisionAgent(sessionId, "live-agent-a");
    const credentialsB = await runtime.provisionAgent(sessionId, "live-agent-b");
    const clientA = await mcpClient(credentialsA);
    const clientB = await mcpClient(credentialsB);
    clients.push(clientA, clientB);
    const initial = documentOf(await clientA.callTool({
      name: "document_read",
      arguments: { workspaceId: "main", path: "note.txt" }
    }) as Record<string, any>);
    evidence.initialDocument = initial;

    await humanGuiEdit();
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
    const humanEdited = documentOf(await clientA.callTool({
      name: "document_read",
      arguments: { workspaceId: "main", path: "note.txt" }
    }) as Record<string, any>);
    if (!humanEdited.text.includes("human edit from real GUI")) {
      throw new Error("The real GUI edit was not visible through MCP");
    }
    evidence.humanEditReadByAgent = humanEdited;

    const stale = await clientB.callTool({
      name: "document_write",
      arguments: {
        workspaceId: "main",
        path: "note.txt",
        text: "stale overwrite",
        expectedVersion: humanEdited.version + 1000
      }
    }) as Record<string, any>;
    if (stale.structuredContent?.error?.code !== "VERSION_CONFLICT") {
      throw new Error("Stale write was not rejected with VERSION_CONFLICT");
    }
    evidence.staleWriteRejected = true;

    const focusBefore = await runtime.supervisor.frontmostApplication();
    const valid = await clientB.callTool({
      name: "document_write",
      arguments: {
        workspaceId: "main",
        path: "note.txt",
        text: `${humanEdited.text}\nagent write without focus steal`,
        expectedVersion: humanEdited.version
      }
    }) as Record<string, any>;
    const validDocument = documentOf(valid);
    const focusAfter = await runtime.supervisor.frontmostApplication();
    if (
      focusBefore.pid !== focusAfter.pid ||
      focusBefore.launchDate !== focusAfter.launchDate
    ) {
      throw new Error("Agent write changed the frontmost application");
    }
    evidence.validAgentWrite = validDocument;
    evidence.frontmostPidUnchanged = focusAfter.pid;

    const concurrent = await Promise.all([
      clientA.callTool({
        name: "document_write",
        arguments: {
          workspaceId: "main",
          path: "note.txt",
          text: "concurrent A",
          expectedVersion: validDocument.version
        }
      }),
      clientB.callTool({
        name: "document_write",
        arguments: {
          workspaceId: "main",
          path: "note.txt",
          text: "concurrent B",
          expectedVersion: validDocument.version
        }
      })
    ]) as Record<string, any>[];
    if (
      concurrent.filter(response => response.isError !== true).length !== 1 ||
      concurrent.filter(response => response.structuredContent?.error?.code === "VERSION_CONFLICT").length !== 1
    ) {
      throw new Error("Concurrent writes did not produce one winner and one conflict");
    }
    evidence.concurrentWrites = "one winner, one VERSION_CONFLICT";

    const events = await clientA.callTool({
      name: "events_read",
      arguments: { after: 0, limit: 200 }
    }) as Record<string, any>;
    if (!events.structuredContent.events.some(
      (event: any) => event.type === "document.changed" && event.origin?.agentId === "live-agent-b"
    )) {
      throw new Error("No real agent-attributed document change event was delivered");
    }
    evidence.documentEventsVerified = true;

    const benchmark: BenchmarkResult = await runBenchmark({
      name: "live-vscode-mcp-document-read",
      warmupIterations: 5,
      iterations: 30,
      operation: async () => {
        const response = await clientA.callTool({
          name: "document_read",
          arguments: { workspaceId: "main", path: "note.txt" }
        }) as Record<string, any>;
        return documentOf(response);
      }
    });
    evidence.mcpDocumentReadBenchmark = benchmark;

    await Promise.all(clients.splice(0).map(client => client.close()));
    await runtime.close();
    runtime = new DualHeadRuntime({ dataRoot });
    await runtime.start();
    const restored = runtime.supervisor.getSession(sessionId);
    const application = restored.applications.find(item => item.id === applicationId);
    if (!application || application.status !== "running" || application.processIdentity !== "verified") {
      throw new Error("VS Code process did not reconcile after supervisor restart");
    }
    await runtime.waitForVSCode(sessionId);
    const restartedA = await mcpClient(credentialsA);
    clients.push(restartedA);
    const afterRestart = documentOf(await restartedA.callTool({
      name: "document_read",
      arguments: { workspaceId: "main", path: "note.txt" }
    }) as Record<string, any>);
    evidence.restart = {
      sessionPersisted: true,
      applicationStatus: application.status,
      processIdentity: application.processIdentity,
      documentReadAfterReconnect: afterRestart
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
    evidence.status = error instanceof BlockedAcceptance ? "BLOCKED" : "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.temporaryDataRoot = dataRoot;
    console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = error instanceof BlockedAcceptance ? 2 : 1;
  } finally {
    if (!cleanupComplete) {
      await Promise.allSettled(clients.map(client => client.close()));
      if (sessionId && applicationId) {
        await runtime.supervisor.terminateApplication(sessionId, applicationId).catch(() => undefined);
      }
      await runtime.close().catch(() => undefined);
      if (!applicationId) {
        await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
      } else {
        console.error(`Temporary VS Code profile retained for inspection: ${dataRoot}`);
      }
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
