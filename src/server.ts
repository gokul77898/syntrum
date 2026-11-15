import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DualHeadRuntime } from "./integration/index.js";
import {
  createConsoleLogger,
  log,
  RuntimeError,
  RuntimeSupervisor,
  type Logger
} from "./runtime/index.js";

const HOST = "127.0.0.1";
const PORT = 4317;
const DEFAULT_BODY_LIMIT = 16_384;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type RuntimeHttpOptions = {
  logger?: Logger;
  bodyLimitBytes?: number;
  dualHead?: DualHeadRuntime;
};

export function createRuntimeHttpServer(
  supervisor: RuntimeSupervisor,
  options: RuntimeHttpOptions = {}
): Server {
  const logger = options.logger ?? createConsoleLogger();
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const dualHead = options.dualHead;

  return createServer((req, res) => {
    const requestId = randomUUID();
    void handleRequest(req, res, requestId, supervisor, bodyLimit, dualHead).catch(error => {
      const runtimeError = error instanceof RuntimeError || error instanceof HttpError
        ? error
        : undefined;
      const statusCode = runtimeError?.statusCode ?? 500;
      const code = runtimeError?.code ?? "INTERNAL_ERROR";
      const message = runtimeError?.message ?? "Internal server error";
      const details = runtimeError instanceof RuntimeError ? runtimeError.details : undefined;

      log(
        logger,
        statusCode >= 500 ? "error" : "info",
        "http.request_failed",
        message,
        {
          requestId,
          method: req.method,
          path: req.url,
          statusCode,
          code,
          ...(!runtimeError && error instanceof Error ? { cause: error.message } : {})
        }
      );

      if (!res.headersSent) {
        respond(res, statusCode, {
          error: message,
          code,
          requestId,
          ...details
        }, requestId);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  supervisor: RuntimeSupervisor,
  bodyLimit: number,
  dualHead?: DualHeadRuntime
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;

  if (method === "GET" && pathname === "/health") {
    respond(res, 200, {
      service: "Cloud AI OS Runtime Supervisor",
      status: "healthy",
      sessions: supervisor.countSessions()
    }, requestId);
    return;
  }

  if (pathname === "/sessions") {
    if (method === "POST") {
      const session = dualHead
        ? await dualHead.createSession()
        : supervisor.createSession();
      respond(res, 201, { message: "Session created", session }, requestId);
      return;
    }
    if (method === "GET") {
      const sessions = supervisor.listSessions();
      respond(res, 200, { count: sessions.length, sessions }, requestId);
      return;
    }
  }

  const agentMatch = pathname.match(/^\/sessions\/([^/]+)\/agents$/);
  if (agentMatch && method === "POST") {
    if (!dualHead) {
      throw new RuntimeError(404, "DUAL_HEAD_NOT_ENABLED", "Dual-head runtime is not enabled");
    }
    const body = await readJsonObject(req, bodyLimit);
    if (typeof body.agentId !== "string") {
      throw new RuntimeError(400, "INVALID_AGENT_ID", "Invalid agent ID");
    }
    const agent = await dualHead.provisionAgent(agentMatch[1], body.agentId);
    respond(res, 201, { message: "Agent provisioned", agent }, requestId);
    return;
  }

  const vscodeMatch = pathname.match(/^\/sessions\/([^/]+)\/vscode$/);
  if (vscodeMatch && method === "POST") {
    if (!dualHead) {
      throw new RuntimeError(404, "DUAL_HEAD_NOT_ENABLED", "Dual-head runtime is not enabled");
    }
    const result = await dualHead.launchVSCode(vscodeMatch[1]);
    respond(res, result.created ? 201 : 200, {
      message: result.created ? "VS Code launch requested" : "VS Code already registered",
      sessionId: vscodeMatch[1],
      application: result.application
    }, requestId);
    return;
  }

  const readinessMatch = pathname.match(/^\/sessions\/([^/]+)\/dual-head$/);
  if (readinessMatch && method === "GET") {
    if (!dualHead) {
      throw new RuntimeError(404, "DUAL_HEAD_NOT_ENABLED", "Dual-head runtime is not enabled");
    }
    respond(res, 200, dualHead.readiness(readinessMatch[1]), requestId);
    return;
  }

  const appMatch = pathname.match(/^\/sessions\/([^/]+)\/apps\/([^/]+)$/);
  if (appMatch) {
    const [, sessionId, reference] = appMatch;
    if (method === "GET") {
      const application = await supervisor.getApplicationByReference(sessionId, reference);
      respond(res, 200, { sessionId, application }, requestId);
      return;
    }
    if (method === "DELETE") {
      const result = await supervisor.terminateApplication(sessionId, reference);
      if (result.alreadyExited) {
        respond(res, 200, {
          message: "Application already exited",
          application: result.application
        }, requestId);
        return;
      }

      const waiting = result.application.status === "termination_requested";
      respond(res, waiting ? 202 : 200, {
        message: waiting
          ? "Termination requested; process is still running"
          : "Application exited",
        terminationRequested: result.terminationRequested,
        application: result.application
      }, requestId);
      return;
    }
  }

  const appsMatch = pathname.match(/^\/sessions\/([^/]+)\/apps$/);
  if (appsMatch) {
    const sessionId = appsMatch[1];
    if (method === "GET") {
      const applications = await supervisor.listApplications(sessionId);
      respond(res, 200, {
        sessionId,
        count: applications.length,
        applications
      }, requestId);
      return;
    }
    if (method === "POST") {
      const body = await readJsonObject(req, bodyLimit);
      const bundleIdentifier = body.bundleIdentifier;
      if (typeof bundleIdentifier !== "string") {
        throw new RuntimeError(400, "INVALID_BUNDLE_IDENTIFIER", "Invalid bundleIdentifier");
      }

      const result = await supervisor.launchApplication(sessionId, bundleIdentifier);
      if (!result.created) {
        respond(res, 200, {
          message: "Application already registered",
          application: result.application
        }, requestId);
        return;
      }

      respond(res, 201, {
        message: result.application.processOrigin === "pre_existing" ||
          result.application.processOrigin === "shared"
          ? "Application registered"
          : "Application launched and registered",
        sessionId,
        application: result.application
      }, requestId);
      return;
    }
  }

  const eventsMatch = pathname.match(/^\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const afterText = url.searchParams.get("after") ?? "0";
    const limitText = url.searchParams.get("limit") ?? "100";
    const after = /^\d+$/.test(afterText) ? Number(afterText) : -1;
    const limit = /^\d+$/.test(limitText) ? Number(limitText) : 0;
    const events = supervisor.listEvents(eventsMatch[1], after, limit);
    respond(res, 200, {
      sessionId: eventsMatch[1],
      count: events.length,
      events
    }, requestId);
    return;
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "GET") {
    respond(res, 200, supervisor.getSession(sessionMatch[1]), requestId);
    return;
  }

  throw new RuntimeError(404, "ROUTE_NOT_FOUND", "Route not found");
}

function respond(
  res: ServerResponse,
  status: number,
  data: unknown,
  requestId: string
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-Id": requestId
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

async function readJsonObject(
  req: IncomingMessage,
  limit: number
): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    req.resume();
    throw new HttpError(413, "REQUEST_BODY_TOO_LARGE", "Request body too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }

  if (tooLarge) {
    throw new HttpError(413, "REQUEST_BODY_TOO_LARGE", "Request body too large");
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON request body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_JSON_BODY", "Expected a JSON object");
  }
  return body as Record<string, unknown>;
}

async function main(): Promise<void> {
  const logger = createConsoleLogger();
  const runtime = new DualHeadRuntime({
    dataRoot: process.env.CLOUD_AI_OS_DATA_ROOT,
    databasePath: process.env.CLOUD_AI_OS_DB_PATH,
    extensionDevelopmentPath: process.env.CLOUD_AI_OS_VSCODE_EXTENSION_PATH,
    logger
  });
  await runtime.start();
  const server = createRuntimeHttpServer(runtime.supervisor, { logger, dualHead: runtime });

  server.listen(PORT, HOST, () => {
    log(logger, "info", "runtime.started", "Cloud AI OS Runtime Supervisor is ready", {
      url: `http://${HOST}:${PORT}`
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(logger, "info", "runtime.stopping", "Runtime supervisor is stopping", { signal });
    server.close(() => {
      void runtime.close().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
