import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { runBenchmark } from "../benchmarks/index.js";
import {
  ANTIGRAVITY_IDE_PROFILE,
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

const GUI_INPUT_PATH = resolve(process.cwd(), ".build/gui-input");

async function guiInput(args: string[]): Promise<void> {
  await execFileAsync(GUI_INPUT_PATH, args, { timeout: 20_000 });
}

/**
 * Brings a harmless, always-running application to the front so the focus
 * test has a frontmost application that is not the IDE.
 */
async function activateNeutralApplication(): Promise<void> {
  await execFileAsync(
    "osascript",
    ["-e", 'tell application "Finder" to activate'],
    { timeout: 10_000 }
  );
}

async function openDocumentInGUI(dataRoot: string, sessionId: string): Promise<void> {
  const profileRoot = join(dataRoot, "sessions", sessionId, "antigravity-profile");
  await execFileAsync(
    join(
      ANTIGRAVITY_IDE_PROFILE.applicationPath,
      "Contents/Resources/app/bin/antigravity-ide"
    ),
    [
      "--user-data-dir", join(profileRoot, "user-data"),
      "--extensions-dir", join(profileRoot, "extensions"),
      "--goto", join(dataRoot, "sessions", sessionId, "workspace", "note.txt")
    ],
    { timeout: 15_000 }
  );
}

async function completeOnboarding(applicationPid: number): Promise<void> {
  // Antigravity shows a first-run screen in a fresh isolated profile. The
  // extension host connects regardless, so onboarding is best effort: the
  // real gate is the extension handshake, not this click.
  try {
    await guiInput(["click", String(applicationPid), "1470", "1085"]);
  } catch {
    // Ignored on purpose; see the comment above.
  }
}

/**
 * Performs a real GUI edit inside the focused Antigravity editor.
 *
 * `gui-input type` posts real CGEvent key events: Command-A selects the
 * buffer, then the replacement text is typed over it. The edit therefore
 * originates from the real editor, produces real TextDocument versions and
 * real onDidChangeTextDocument events, and is indistinguishable from a
 * human keystroke to the extension.
 */
async function humanGuiEdit(applicationPid: number, text: string): Promise<void> {
  try {
    await guiInput(["type", String(applicationPid), text]);
  } catch (error) {
    throw new BlockedAcceptance(
      `Real GUI input failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function documentOf(response: Record<string, any>) {
  if (response.isError) {
    throw new Error(JSON.stringify(response.structuredContent));
  }
  return response.structuredContent.document as { text: string; version: number };
}

async function readAfterReconnect(
  runtime: DualHeadRuntime,
  client: Client,
  sessionId: string
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return documentOf(await client.callTool({
        name: "document_read",
        arguments: { workspaceId: "main", path: "note.txt" }
      }) as Record<string, any>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EXTENSION_NOT_CONNECTED") && !message.includes("EXTENSION_DISCONNECTED")) {
        throw error;
      }
      await runtime.waitForVSCode(sessionId);
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
  }
  throw new Error("Antigravity did not stay connected long enough to read the document");
}

async function main(): Promise<void> {
  const appPath = resolve(ANTIGRAVITY_IDE_PROFILE.applicationPath);
  try {
    await stat(appPath);
  } catch {
    console.log(JSON.stringify({ status: "BLOCKED", reason: `Antigravity not found at ${appPath}` }, null, 2));
    process.exitCode = 2;
    return;
  }

  process.env.CLOUD_AI_OS_DEBUG_BRIDGE = "1";
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-live-"));
  let runtime = new DualHeadRuntime({ dataRoot, ide: ANTIGRAVITY_IDE_PROFILE });
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
    const launch = await runtime.launchIDE(sessionId);
    applicationId = launch.application.id;
    evidence.antigravity = {
      pid: launch.application.pid,
      processOrigin: launch.application.processOrigin,
      processIdentity: launch.application.processIdentity
    };
    await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
    await completeOnboarding(launch.application.pid);
    await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
    await runtime.waitForVSCode(sessionId);

    const credentialsA = await runtime.provisionAgent(sessionId, "live-agent-a");
    const credentialsB = await runtime.provisionAgent(sessionId, "live-agent-b");
    const clientA = await mcpClient(credentialsA);
    const clientB = await mcpClient(credentialsB);
    clients.push(clientA, clientB);
    evidence.initialDocument = documentOf(await clientA.callTool({
      name: "document_read",
      arguments: { workspaceId: "main", path: "note.txt" }
    }) as Record<string, any>);
    await openDocumentInGUI(dataRoot, sessionId);
    await runtime.waitForVSCode(sessionId);
    await new Promise(resolveWait => setTimeout(resolveWait, 2_000));

    const humanEdit = humanGuiEdit(launch.application.pid, "human edit from real GUI");
    const agentReadDuringHumanEdit = (async () => {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      return readAfterReconnect(runtime, clientA, sessionId);
    })();
    await Promise.all([humanEdit, agentReadDuringHumanEdit]);
    evidence.concurrentHumanAndAgent = true;
    const humanEdited = await readAfterReconnect(runtime, clientA, sessionId);
    evidence.humanEditReadByAgent = humanEdited;
    if (!humanEdited.text.includes("human edit from real GUI")) {
      throw new Error("The real GUI edit was not visible through MCP");
    }

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
    if (focusBefore.pid !== focusAfter.pid || focusBefore.launchDate !== focusAfter.launchDate) {
      throw new Error("Agent write changed the frontmost application");
    }
    evidence.validAgentWrite = validDocument;
    evidence.frontmostPidUnchanged = focusAfter.pid;

    // Stronger focus test. With a non-IDE application frontmost, agent
    // operations must neither change the frontmost application nor activate
    // Antigravity. The first check above only proves the focus did not
    // change while the IDE was already frontmost.
    await activateNeutralApplication();
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    const neutralBefore = await runtime.supervisor.frontmostApplication();
    const neutralRead = documentOf(await clientA.callTool({
      name: "document_read",
      arguments: { workspaceId: "main", path: "note.txt" }
    }) as Record<string, any>);
    const neutralWrite = await clientB.callTool({
      name: "document_write",
      arguments: {
        workspaceId: "main",
        path: "note.txt",
        text: `${neutralRead.text}\nagent write while another application is frontmost`,
        expectedVersion: neutralRead.version
      }
    }) as Record<string, any>;
    const neutralDocument = documentOf(neutralWrite);
    const neutralAfter = await runtime.supervisor.frontmostApplication();
    if (neutralBefore.pid !== neutralAfter.pid || neutralBefore.launchDate !== neutralAfter.launchDate) {
      throw new Error(
        `Agent operations changed the frontmost application: ${JSON.stringify({
          before: neutralBefore,
          after: neutralAfter
        })}`
      );
    }
    if (neutralAfter.bundleIdentifier === ANTIGRAVITY_IDE_PROFILE.bundleIdentifier) {
      throw new Error("Agent operations activated Antigravity");
    }
    evidence.focusPreservation = {
      ideFrontmostUnchanged: {
        pid: focusAfter.pid,
        bundleIdentifier: focusAfter.bundleIdentifier
      },
      nonIdeFrontmostUnchanged: {
        pid: neutralAfter.pid,
        bundleIdentifier: neutralAfter.bundleIdentifier,
        ideActivated: false
      },
      agentWriteWhileNonIdeFrontmost: neutralDocument
    };

    const concurrent = await Promise.all([
      clientA.callTool({
        name: "document_write",
        arguments: {
          workspaceId: "main",
          path: "note.txt",
          text: "concurrent A",
          expectedVersion: neutralDocument.version
        }
      }),
      clientB.callTool({
        name: "document_write",
        arguments: {
          workspaceId: "main",
          path: "note.txt",
          text: "concurrent B",
          expectedVersion: neutralDocument.version
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

    evidence.mcpDocumentReadBenchmark = await runBenchmark({
      name: "live-antigravity-mcp-document-read",
      warmupIterations: 5,
      iterations: 30,
      operation: async () => documentOf(await clientA.callTool({
        name: "document_read",
        arguments: { workspaceId: "main", path: "note.txt" }
      }) as Record<string, any>)
    });

    await Promise.all(clients.splice(0).map(client => client.close()));
    await runtime.close();
    runtime = new DualHeadRuntime({ dataRoot, ide: ANTIGRAVITY_IDE_PROFILE });
    await runtime.start();
    const restored = runtime.supervisor.getSession(sessionId);
    const application = restored.applications.find(item => item.id === applicationId);
    if (!application || application.status !== "running" || application.processIdentity !== "verified") {
      throw new Error("Antigravity process did not reconcile after supervisor restart");
    }
    await runtime.waitForVSCode(sessionId);
    const restartedA = await mcpClient(credentialsA);
    clients.push(restartedA);
    evidence.restart = {
      sessionPersisted: true,
      applicationStatus: application.status,
      processIdentity: application.processIdentity,
      documentReadAfterReconnect: documentOf(await restartedA.callTool({
        name: "document_read",
        arguments: { workspaceId: "main", path: "note.txt" }
      }) as Record<string, any>)
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
