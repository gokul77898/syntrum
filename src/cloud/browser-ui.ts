import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { join } from "node:path";

import { DesktopGateway } from "./desktop-gateway.js";

/**
 * Browser surface for SYNTRUM.
 *
 * The cloud control plane stays untouched and loopback-only. This server holds the
 * operator credential in memory, authenticates the browser once with a short-lived
 * HttpOnly cookie, and proxies a narrow, allowlisted API surface to the control plane.
 * The browser never receives the operator token, the worker host, or the SSH identity.
 */

const SESSION_COOKIE = "syntrum_gui";
const SESSION_TTL_MS = 30 * 60_000;
const BODY_LIMIT = 16_384;

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/icons.js": { file: "icons.js", type: "text/javascript; charset=utf-8" },
  "/views.js": { file: "views.js", type: "text/javascript; charset=utf-8" }
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

export type Session = { expiresAt: number; csrf: string };

export type BrowserUiOptions = {
  /** Loopback base URL of the existing cloud control plane, e.g. http://127.0.0.1:4318 */
  cloudBaseUrl: string;
  /** Operator bearer token. Never sent to the browser. */
  operatorToken: string;
  /** Directory containing index.html, app.css, app.js, icons.js, views.js */
  webRoot: string;
  /** SSH destination of the worker that hosts the guests, e.g. gokul@10.0.0.5 */
  workerHost?: string;
  workerKnownHostsPath?: string;
  workerIdentityFile?: string;
};

type Ctx = {
  base: string;
  operatorToken: string;
  webRoot: string;
  sessions: Map<string, Session>;
  gateway?: DesktopGateway;
};

export function createBrowserUi({
  cloudBaseUrl,
  operatorToken,
  webRoot,
  workerHost,
  workerKnownHostsPath,
  workerIdentityFile
}: BrowserUiOptions): Server {
  if (operatorToken.length < 32) {
    throw new TypeError("Operator token must contain at least 32 characters");
  }
  const base = cloudBaseUrl.replace(/\/+$/, "");
  const ctx: Ctx = {
    base,
    operatorToken,
    webRoot,
    sessions: new Map()
  };

  if (workerHost) {
    const separator = workerHost.lastIndexOf("@");
    if (separator <= 0) {
      throw new TypeError("workerHost must be in user@host form");
    }
    const ssh = {
      user: workerHost.slice(0, separator),
      host: workerHost.slice(separator + 1),
      knownHostsPath: workerKnownHostsPath,
      identityFile: workerIdentityFile
    };
    ctx.gateway = new DesktopGateway({
      ssh,
      // The authenticated session is the authorization: authorize() below is
      // the same check every other API route uses.
      authorize: (req: IncomingMessage) => authorize(req, ctx.sessions) !== null,
      // Resolved from the control plane, never from the request. details()
      // reports the instance's real addresses, so the browser cannot name a
      // host: an unaddressable computer fails here instead of being dialled.
      resolveTarget: async (id: string) => {
        const response = await fetch(
          `${base}/computers/${encodeURIComponent(id)}/details`,
          {
            headers: { authorization: `Bearer ${operatorToken}` },
            signal: AbortSignal.timeout(6000)
          }
        );
        if (!response.ok) {
          throw new Error(`Control plane returned ${response.status}`);
        }
        const payload = await response.json() as {
          details?: { ipAddresses?: string[] };
          computer?: { desktopPort?: number };
        };
        const host = payload.details?.ipAddresses?.find(address => !address.includes(":"));
        const port = payload.computer?.desktopPort ??
          (await desktopPort(base, operatorToken, id));
        if (!host || !port) {
          throw new Error("The desktop has no reachable address yet");
        }
        return { host, port };
      }
    });
  }

  const server = createServer((req, res) => {
    void route(req, res, ctx).catch(error => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "Internal error",
          code: "INTERNAL_ERROR"
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  // The desktop stream is a raw TCP bridge, so it is handled at the upgrade
  // event rather than through the request router.
  server.on("upgrade", (req, socket, head) => {
    const gateway = ctx.gateway;
    const match = /^\/desktop\/([^/]+)\/websockify$/.exec(
      new URL(req.url ?? "/", "http://localhost").pathname
    );
    if (!gateway || !match) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void gateway
      .handleUpgrade(req, socket, head as Buffer, decodeURIComponent(match[1]))
      .catch(() => socket.destroy());
  });

  return server;
}

// The desktop port is part of the computer record; details() does not repeat
// it, so it is read from the same control-plane object the UI already uses.
async function desktopPort(
  base: string,
  operatorToken: string,
  id: string
): Promise<number | undefined> {
  const response = await fetch(`${base}/computers/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${operatorToken}` },
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { computer?: { desktopPort?: number } };
  return payload.computer?.desktopPort;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  for (const [key, value] of Object.entries(securityHeaders())) res.setHeader(key, value);

  if (method === "GET" && STATIC[path]) {
    const asset = STATIC[path];
    const body = await readFile(join(ctx.webRoot, asset.file));
    res.writeHead(200, { "Content-Type": asset.type });
    res.end(body);
    return;
  }

  if (path === "/api/login" && method === "POST") {
    const body = await readJson(req);
    const token = typeof body.token === "string" ? body.token : "";
    if (!constantTimeString(token, ctx.operatorToken)) {
      sendJson(res, 401, {
        error: "That operator token was not accepted.",
        code: "UNAUTHORIZED"
      });
      return;
    }
    sweepExpired(ctx.sessions);
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    ctx.sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS, csrf });
    res.setHeader("Set-Cookie", cookie(id, 1800));
    sendJson(res, 200, { authenticated: true, csrf });
    return;
  }

  if (path === "/api/logout" && method === "POST") {
    const id = sessionId(req);
    if (id) ctx.sessions.delete(id);
    res.setHeader("Set-Cookie", cookie("", 0));
    sendJson(res, 200, { authenticated: false });
    return;
  }

  if (path === "/api/session" && method === "GET") {
    const session = authorize(req, ctx.sessions);
    sendJson(res, 200, session
      ? { authenticated: true, csrf: session.csrf }
      : { authenticated: false });
    return;
  }

  const session = authorize(req, ctx.sessions);
  if (!session) {
    sendJson(res, 401, {
      error: "Your session has expired. Sign in again.",
      code: "SESSION_EXPIRED"
    });
    return;
  }

  if (method !== "GET") {
    if (!constantTimeString(csrfHeader(req), session.csrf)) {
      sendJson(res, 403, {
        error: "This action could not be verified. Refresh the page and retry.",
        code: "CSRF_REQUIRED"
      });
      return;
    }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      sendJson(res, 403, {
        error: "Cross-origin actions are not permitted.",
        code: "ORIGIN_REJECTED"
      });
      return;
    }
  }

  if (path === "/api/health" && method === "GET") {
    sendJson(res, 200, { controlPlane: await probe(ctx.base, ctx.operatorToken) });
    return;
  }

  // Desktop state is computed here because the authenticated noVNC gateway does not
  // exist yet. We describe the real computer state instead of implying a screen.
  const desktop = path.match(/^\/api\/computers\/([^/]+)\/desktop$/);
  if (desktop) {
    await replyDesktop(res, desktop[1], ctx);
    return;
  }

  // noVNC's own files, fetched from the guest's installed copy and served
  // same-origin so the session cookie authorizes them. Nothing third-party is
  // vendored here, and the path is a path — never a URL.
  const asset = path.match(/^\/desktop\/([^/]+)\/(.+)$/);
  if (asset && method === "GET") {
    if (!ctx.gateway) {
      sendJson(res, 503, {
        error: "The desktop gateway is not configured on this server.",
        code: "GATEWAY_DISABLED"
      });
      return;
    }
    await ctx.gateway.proxyAsset(
      req,
      res,
      decodeURIComponent(asset[1]),
      `/${asset[2]}`
    );
    return;
  }

  const forward = toControlPlanePath(path);
  if (forward) {
    await proxy(req, res, `${ctx.base}${forward}${url.search}`, method, ctx.operatorToken);
    return;
  }

  sendJson(res, 404, { error: "Route not found.", code: "ROUTE_NOT_FOUND" });
}

/** Maps the browser's /api/* surface onto the existing control-plane routes. */
function toControlPlanePath(path: string): string | undefined {
  const allowed = [
    /^\/api\/computers$/,
    /^\/api\/computers\/[^/]+$/,
    /^\/api\/computers\/[^/]+\/(start|stop|restart|details|access)$/,
    /^\/api\/workers$/,
    /^\/api\/gpus$/,
    /^\/api\/gpu\/allocations$/,
    /^\/api\/gpu\/metrics$/
  ];
  if (!allowed.some(pattern => pattern.test(path))) return undefined;
  return path.slice("/api".length);
}

async function replyDesktop(res: ServerResponse, id: string, ctx: Ctx): Promise<void> {
  let computer: Record<string, unknown> | undefined;
  try {
    const response = await fetch(`${ctx.base}/computers/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${ctx.operatorToken}` },
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      computer = ((await response.json()) as { computer?: Record<string, unknown> }).computer;
    }
  } catch {
    sendJson(res, 502, {
      error: "The SYNTRUM control plane is unreachable.",
      code: "CONTROL_PLANE_UNREACHABLE"
    });
    return;
  }

  if (!computer) {
    sendJson(res, 404, { error: "Computer not found.", code: "COMPUTER_NOT_FOUND" });
    return;
  }

  const status = String(computer.status);
  const desktopEnabled = computer.desktopEnabled === true;

  // The real entry point: the browser loads noVNC from the guest itself, and
  // the socket URL is the gateway's own path. Nothing here names the worker,
  // its address, or the container IP — those stay on this side of the gate.
  if (status === "running" && desktopEnabled) {
    sendJson(res, 200, {
      available: true,
      gateway: "noVNC over SSH stream",
      path: `/desktop/${encodeURIComponent(id)}/vnc.html`,
      socketPath: `/desktop/${encodeURIComponent(id)}/websockify`,
      reason: undefined,
      computer: {
        id: computer.id,
        status,
        desktopEnabled,
        cpu: computer.cpu,
        memoryMb: computer.memoryMb,
        diskGb: computer.diskGb,
        createdAt: computer.createdAt
      }
    });
    return;
  }

  const reason = status !== "running"
    ? `Desktop unavailable: this computer is ${status}. Start it to attach a screen.`
    : "This computer was provisioned without a desktop environment.";

  sendJson(res, 200, {
    available: false,
    gateway: "none",
    reason,
    computer: {
      id: computer.id,
      status,
      desktopEnabled,
      cpu: computer.cpu,
      memoryMb: computer.memoryMb,
      diskGb: computer.diskGb,
      createdAt: computer.createdAt
    }
  });
}

async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  method: string,
  token: string
): Promise<void> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const hasBody = method !== "GET" && method !== "DELETE";
  if (hasBody) headers["content-type"] = "application/json";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await rawBody(req) : undefined,
      signal: AbortSignal.timeout(120_000)
    });
  } catch {
    sendJson(res, 502, {
      error: "The SYNTRUM control plane is unreachable. Start it with `npm run cloud:dev`.",
      code: "CONTROL_PLANE_UNREACHABLE"
    });
    return;
  }

  const payload = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
  });
  res.end(payload);
}

async function probe(base: string, token: string): Promise<"healthy" | "unreachable"> {
  try {
    const response = await fetch(`${base}/workers`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000)
    });
    return response.ok ? "healthy" : "unreachable";
  } catch {
    return "unreachable";
  }
}

function sweepExpired(sessions: Map<string, Session>): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function authorize(req: IncomingMessage, sessions: Map<string, Session>): Session | null {
  const id = sessionId(req);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function sessionId(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

function csrfHeader(req: IncomingMessage): string {
  const value = req.headers["x-syntrum-csrf"];
  return typeof value === "string" ? value : "";
}

function cookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function constantTimeString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
    "Cache-Control": "no-store"
  };
}

async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8") || "{}";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await rawBody(req);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(data)}\n`);
}

/* ── standalone launcher ──────────────────────────────── */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const port = Number(process.env.SYNTRUM_UI_PORT ?? 4173);
  const host = process.env.SYNTRUM_UI_HOST ?? "127.0.0.1";
  const server = createBrowserUi({
    cloudBaseUrl: process.env.SYNTRUM_CLOUD_URL ?? "http://127.0.0.1:4318",
    operatorToken: required("CLOUD_AI_OS_OPERATOR_TOKEN"),
    webRoot: process.env.SYNTRUM_WEB_ROOT ?? new URL("../../web/", import.meta.url).pathname
  });

  server.listen(port, host, () => {
    console.log(`SYNTRUM UI   http://${host}:${port}`);
    console.log(`Control plane ${process.env.SYNTRUM_CLOUD_URL ?? "http://127.0.0.1:4318"}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
  : false;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
