import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BusClient } from "../bus/index.js";
import { BusApplicationAdapter } from "./bus-adapter.js";
import {
  ADAPTER_PERMISSIONS,
  AdapterPermission,
  createAdapterMcpServer
} from "./server.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stringSet(name: string): Set<string> {
  return new Set(
    requiredEnvironment(name).split(",").map(item => item.trim()).filter(Boolean)
  );
}

async function main(): Promise<void> {
  const permissions = stringSet("CLOUD_AI_OS_MCP_PERMISSIONS");
  for (const permission of permissions) {
    if (!ADAPTER_PERMISSIONS.includes(permission as AdapterPermission)) {
      throw new Error(`Unknown MCP permission '${permission}'`);
    }
  }

  const client = await BusClient.connect({
    socketPath: requiredEnvironment("CLOUD_AI_OS_BUS_SOCKET"),
    agent: {
      id: requiredEnvironment("CLOUD_AI_OS_AGENT_ID"),
      token: requiredEnvironment("CLOUD_AI_OS_AGENT_TOKEN")
    }
  });
  const adapter = new BusApplicationAdapter(client);
  const server = createAdapterMcpServer(adapter, {
    identity: {
      agentId: requiredEnvironment("CLOUD_AI_OS_AGENT_ID"),
      sessionId: requiredEnvironment("CLOUD_AI_OS_SESSION_ID")
    },
    permissions: permissions as Set<AdapterPermission>,
    workspaceIds: stringSet("CLOUD_AI_OS_MCP_WORKSPACES")
  });

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await client.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await server.close();
    await adapter.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
