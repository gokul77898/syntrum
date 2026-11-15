import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusClient } from "../bus/index.js";
import {
  ANTIGRAVITY_IDE_PROFILE,
  DualHeadRuntime
} from "../integration/index.js";

async function main(): Promise<void> {
  process.env.CLOUD_AI_OS_DEBUG_BRIDGE = "1";
  const dataRoot = await mkdtemp(join("/tmp", "agp-"));
  const runtime = new DualHeadRuntime({
    dataRoot,
    ide: ANTIGRAVITY_IDE_PROFILE
  });
  let sessionId: string | undefined;
  let applicationId: string | undefined;
  let client: BusClient | undefined;
  let removeData = false;

  try {
    await runtime.start();
    const session = await runtime.createSession();
    sessionId = session.id;
    const resource = runtime.supervisor.getSessionResource(sessionId)!;
    await writeFile(join(resource.workspaceRoot, "note.txt"), "real Antigravity probe\n");
    const launch = await runtime.launchIDE(sessionId);
    applicationId = launch.application.id;
    const credentials = await runtime.provisionAgent(sessionId, "antigravity-probe");
    client = await BusClient.connect({
      socketPath: credentials.busSocketPath,
      agent: { id: credentials.agentId, token: credentials.token }
    });
    const workspaces = await client.listWorkspaces({ sessionId });
    const result = await client.readDocument({
      sessionId,
      workspaceId: "main",
      path: "note.txt"
    });
    console.log(JSON.stringify({
      status: "VERIFIED",
      application: launch.application,
      workspaces: workspaces.workspaces,
      document: {
        path: result.document.path,
        version: result.document.version,
        text: result.document.text,
        dirty: result.document.dirty
      },
      dataRoot
    }, null, 2));
    await client.close();
    client = undefined;
    await runtime.supervisor.terminateApplication(sessionId, applicationId);
    applicationId = undefined;
    await runtime.close();
    removeData = true;
  } catch (error) {
    console.error(JSON.stringify({
      status: "BLOCKED",
      error: error instanceof Error ? error.message : String(error),
      sessionId,
      applicationId,
      dataRoot
    }, null, 2));
    process.exitCode = 2;
  } finally {
    await client?.close().catch(() => undefined);
    if (!removeData) {
      if (sessionId) {
        const applications = runtime.supervisor.getSession(sessionId).applications;
        for (const application of applications) {
          if (application.processOrigin === "launched" && application.status !== "exited") {
            await runtime.supervisor.terminateApplication(sessionId, application.id).catch(() => undefined);
          }
        }
      }
      await runtime.close().catch(() => undefined);
      console.error(`Diagnostic profile retained at ${dataRoot}`);
    } else {
      await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
