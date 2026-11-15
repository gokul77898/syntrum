import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import {
  AdapterError,
  AgentIdentity,
  ApplicationAdapter,
  assertAgentIdentity
} from "../adapters/index.js";

export const ADAPTER_PERMISSIONS = [
  "workspace:list",
  "document:list",
  "document:read",
  "document:write",
  "events:read"
] as const;

export type AdapterPermission = typeof ADAPTER_PERMISSIONS[number];

export interface AgentAccess {
  identity: AgentIdentity;
  permissions: ReadonlySet<AdapterPermission>;
  workspaceIds: ReadonlySet<string>;
}

interface ToolDefinition {
  name: string;
  description: string;
  permission: AdapterPermission;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "workspace_list",
    description: "List configured VS Code workspaces available to this agent.",
    permission: "workspace:list",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "document_list",
    description: "List text documents currently open in an allowed VS Code workspace.",
    permission: "document:list",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
      required: ["workspaceId"],
      additionalProperties: false
    }
  },
  {
    name: "document_read",
    description: "Read an existing workspace-relative text document and its VS Code version.",
    permission: "document:read",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        path: { type: "string" }
      },
      required: ["workspaceId", "path"],
      additionalProperties: false
    }
  },
  {
    name: "document_write",
    description: "Replace a document through VS Code only when expectedVersion matches.",
    permission: "document:write",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        path: { type: "string" },
        text: { type: "string" },
        expectedVersion: { type: "integer", minimum: 1 }
      },
      required: ["workspaceId", "path", "text", "expectedVersion"],
      additionalProperties: false
    }
  },
  {
    name: "events_read",
    description: "Read the adapter event stream after a cursor without consuming events for other agents.",
    permission: "events:read",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    }
  }
];

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function errorResult(error: unknown) {
  const adapterError = error instanceof AdapterError
    ? error
    : new AdapterError(
      error instanceof Error ? error.message : "Adapter operation failed",
      "OPERATION_FAILED"
    );
  return {
    isError: true,
    ...result({
      error: {
        code: adapterError.code,
        message: adapterError.message,
        details: adapterError.details ?? null
      }
    })
  };
}

function argumentsObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError("Tool arguments must be an object", "INVALID_ARGUMENTS");
  }
  return value as Record<string, unknown>;
}

function exactArguments(
  args: Record<string, unknown>,
  allowed: string[],
  required: string[] = []
): void {
  const keys = Object.keys(args);
  if (
    keys.some(key => !allowed.includes(key)) ||
    required.some(key => args[key] === undefined)
  ) {
    throw new AdapterError("Invalid tool arguments", "INVALID_ARGUMENTS");
  }
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || args[key].length === 0) {
    throw new AdapterError(`'${key}' must be a nonempty string`, "INVALID_ARGUMENTS");
  }
  return args[key];
}

export function createAdapterMcpServer(
  adapter: ApplicationAdapter,
  access: AgentAccess
): Server {
  assertAgentIdentity(access.identity);
  if (!(access.permissions instanceof Set) || !(access.workspaceIds instanceof Set)) {
    throw new TypeError("Permissions and workspaceIds must be Sets");
  }
  for (const permission of access.permissions) {
    if (!ADAPTER_PERMISSIONS.includes(permission)) {
      throw new TypeError(`Unknown adapter permission '${permission}'`);
    }
  }

  const allowedTools = TOOLS.filter(tool => access.permissions.has(tool.permission));
  const server = new Server(
    { name: "cloud-ai-os-adapter", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: `Operations are bound to agent ${access.identity.agentId} in session ${access.identity.sessionId}. Only explicitly allowed workspaces and operations are available.`
    }
  );

  const assertPermission = (permission: AdapterPermission) => {
    if (!access.permissions.has(permission)) {
      throw new AdapterError(
        `Agent lacks '${permission}' permission`,
        "PERMISSION_DENIED",
        { permission }
      );
    }
  };
  const assertWorkspace = (workspaceId: string) => {
    if (!access.workspaceIds.has(workspaceId)) {
      throw new AdapterError(
        `Workspace '${workspaceId}' is not allowed for this agent`,
        "WORKSPACE_DENIED",
        { workspaceId }
      );
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowedTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const tool = TOOLS.find(item => item.name === request.params.name);
      if (!tool) {
        throw new AdapterError("Unknown tool", "UNKNOWN_TOOL");
      }
      assertPermission(tool.permission);
      const args = argumentsObject(request.params.arguments);

      switch (tool.name) {
        case "workspace_list": {
          exactArguments(args, []);
          const workspaces = await adapter.listWorkspaces(access.identity);
          return result({
            workspaces: workspaces.filter(item => access.workspaceIds.has(item.id))
          });
        }
        case "document_list": {
          exactArguments(args, ["workspaceId"], ["workspaceId"]);
          const workspaceId = stringArgument(args, "workspaceId");
          assertWorkspace(workspaceId);
          return result({
            documents: await adapter.listDocuments(access.identity, workspaceId)
          });
        }
        case "document_read": {
          exactArguments(args, ["workspaceId", "path"], ["workspaceId", "path"]);
          const workspaceId = stringArgument(args, "workspaceId");
          assertWorkspace(workspaceId);
          return result({
            document: await adapter.readDocument(
              access.identity,
              workspaceId,
              stringArgument(args, "path")
            )
          });
        }
        case "document_write": {
          exactArguments(
            args,
            ["workspaceId", "path", "text", "expectedVersion"],
            ["workspaceId", "path", "text", "expectedVersion"]
          );
          const workspaceId = stringArgument(args, "workspaceId");
          assertWorkspace(workspaceId);
          if (typeof args.text !== "string") {
            throw new AdapterError("'text' must be a string", "INVALID_ARGUMENTS");
          }
          if (!Number.isSafeInteger(args.expectedVersion) || (args.expectedVersion as number) < 1) {
            throw new AdapterError(
              "'expectedVersion' must be a positive integer",
              "INVALID_ARGUMENTS"
            );
          }
          return result({
            document: await adapter.writeDocument(
              access.identity,
              workspaceId,
              stringArgument(args, "path"),
              args.text,
              { expectedVersion: args.expectedVersion as number }
            )
          });
        }
        case "events_read": {
          exactArguments(args, ["after", "limit"]);
          if (
            (args.after !== undefined &&
              (!Number.isSafeInteger(args.after) || (args.after as number) < 0)) ||
            (args.limit !== undefined &&
              (!Number.isSafeInteger(args.limit) ||
                (args.limit as number) < 1 ||
                (args.limit as number) > 200))
          ) {
            throw new AdapterError("Invalid event cursor or limit", "INVALID_ARGUMENTS");
          }
          const page = await adapter.getEvents(access.identity, {
            after: args.after as number | undefined,
            limit: args.limit as number | undefined
          });
          return result({
            ...page,
            events: page.events.filter(event => access.workspaceIds.has(event.workspaceId))
          });
        }
        default:
          throw new AdapterError("Unsupported tool", "UNKNOWN_TOOL");
      }
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}
