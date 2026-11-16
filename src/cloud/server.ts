import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GpuScheduler } from "../gpu/scheduler.js";
import { NvidiaWorkerAgent } from "../gpu/nvidia-worker-agent.js";
import { GpuStore } from "../gpu/store.js";
import { GpuError, type GpuAllocationRequest } from "../gpu/types.js";
import {
  AccountStore,
  OPERATOR,
  bearerToken,
  tokenMatches,
  type Caller
} from "./accounts.js";
import { IncusWorkerDriver } from "./incus-driver.js";
import { CloudComputerService } from "./service.js";
import { createSshCommandRunner } from "./ssh-command-runner.js";
import { CloudComputerStore } from "./store.js";
import { CloudError } from "./types.js";
import { checkWorkerHealth, WorkerStore } from "./worker.js";

const BODY_LIMIT = 16_384;

export type CloudHttpOptions = {
  service: CloudComputerService;
  operatorToken: string;
  gpuScheduler?: GpuScheduler;
  workerStore?: WorkerStore;
  /** Omitted disables account tokens; the operator token still works. */
  accountStore?: AccountStore;
};

export function createCloudHttpServer(options: CloudHttpOptions): Server {
  if (options.operatorToken.length < 32) {
    throw new TypeError("Operator token must contain at least 32 characters");
  }
  return createServer((req, res) => {
    void handle(req, res, options).catch(error => {
      const status = error instanceof CloudError || error instanceof GpuError
        ? error.statusCode
        : 500;
      const code = error instanceof CloudError || error instanceof GpuError
        ? error.code
        : "INTERNAL_ERROR";
      respond(res, status, {
        error: error instanceof Error ? error.message : "Internal server error",
        code,
        ...(error instanceof CloudError ? error.details ?? {} : {})
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpOptions
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (method === "GET" && pathname === "/health") {
    respond(res, 200, { status: "healthy", service: "SYNTRUM cloud control plane" });
    return;
  }
  const caller = authenticate(req, options);

  // Account administration is the operator's alone: an account must not be
  // able to mint tokens, raise its own limit, or enumerate other tenants.
  if (pathname === "/accounts" && options.accountStore) {
    requireOperator(caller);
    if (method === "GET") {
      respond(res, 200, { accounts: options.accountStore.list() });
      return;
    }
    if (method === "POST") {
      const body = await readJson(req);
      const created = options.accountStore.create(
        String(body.name ?? ""),
        body.maxComputers === undefined ? undefined : Number(body.maxComputers)
      );
      // The token is returned exactly once, here. Only its hash is stored.
      respond(res, 201, { account: created.account, token: created.token });
      return;
    }
  }
  const accountMatch = pathname.match(/^\/accounts\/([^/]+)(?:\/(token|status))?$/);
  if (accountMatch && options.accountStore) {
    requireOperator(caller);
    const [, accountId, operation] = accountMatch;
    if (operation === "token" && method === "POST") {
      respond(res, 200, { token: options.accountStore.rotateToken(accountId) });
      return;
    }
    if (operation === "status" && method === "POST") {
      const body = await readJson(req);
      const status = body.status === "disabled" ? "disabled" : "active";
      respond(res, 200, { account: options.accountStore.setStatus(accountId, status) });
      return;
    }
    if (!operation && method === "GET") {
      respond(res, 200, { account: options.accountStore.get(accountId) });
      return;
    }
  }

  if (pathname === "/gpus" && method === "GET" && options.gpuScheduler) {
    respond(res, 200, { gpus: await options.gpuScheduler.refreshInventory() });
    return;
  }
  if (pathname === "/gpu/allocations" && options.gpuScheduler) {
    if (method === "GET") {
      const activeOnly = new URL(req.url ?? "/", "http://localhost").searchParams.get("active") === "1";
      const allocations = options.gpuScheduler.listAllocations(activeOnly);
      respond(res, 200, { allocations: visibleAllocations(allocations, caller, options) });
      return;
    }
    if (method === "POST") {
      const body = await readJson(req);
      const request = body as GpuAllocationRequest;
      // A GPU allocation is attached to a computer, so access follows the
      // computer's owner rather than anything in the request body.
      if (request.computerId) {
        options.service.get(request.computerId, caller);
      }
      respond(res, 201, { allocation: await options.gpuScheduler.allocate(request) });
      return;
    }
  }
  if (pathname === "/gpu/metrics" && method === "GET" && options.gpuScheduler) {
    const allocationId = new URL(req.url ?? "/", "http://localhost").searchParams.get("allocationId") ?? undefined;
    const metrics = options.gpuScheduler.listMetrics(allocationId);
    const visible = new Set(
      visibleAllocations(options.gpuScheduler.listAllocations(), caller, options).map(item => item.id)
    );
    // A metric with no allocation belongs to no account, so it is filtered out
    // for anyone but the operator rather than being attributed to a tenant.
    respond(res, 200, {
      metrics: metrics.filter(metric =>
        metric.allocationId !== undefined && visible.has(metric.allocationId)
      )
    });
    return;
  }

  if (pathname === "/workers" && method === "GET" && options.workerStore) {
    respond(res, 200, { workers: options.workerStore.list() });
    return;
  }

  if (pathname === "/computers") {
    if (method === "GET") {
      respond(res, 200, { computers: options.service.list(caller) });
      return;
    }
    if (method === "POST") {
      const body = await readJson(req);
      respond(res, 201, {
        computer: await options.service.create({
          cpu: body.cpu as number | undefined,
          memoryMb: body.memoryMb as number | undefined,
          diskGb: body.diskGb as number | undefined,
          desktopEnabled: body.desktopEnabled as boolean | undefined,
          // Validated inside the service against the registered workers, so an
          // unknown host is a 400 rather than a container that exists only in
          // the control plane's records.
          workerHost: body.workerHost as string | undefined
        }, caller)
      });
      return;
    }
  }

  const match = pathname.match(/^\/computers\/([^/]+)(?:\/(start|stop|restart|access|agent-access|details|exec|fork))?$/);
  if (match) {
    const [, id, operation] = match;
    if (operation === "agent-access" && method === "GET") {
      // Ownership is enforced inside agentAccess, which reports another
      // account's computer as missing rather than forbidden.
      respond(res, 200, options.service.agentAccess(id, caller));
      return;
    }
    if (operation === "fork" && method === "POST") {
      const body = await readJson(req);
      // Only the sizing fields are read; the id, port and owner are assigned
      // from the source and the caller, never from the request body.
      respond(res, 201, {
        computer: await options.service.fork(id, {
          cpu: body.cpu as number | undefined,
          memoryMb: body.memoryMb as number | undefined,
          diskGb: body.diskGb as number | undefined,
          desktopEnabled: body.desktopEnabled as boolean | undefined
        }, caller)
      });
      return;
    }
    if (operation === "access" && method === "GET") {
      respond(res, 200, options.service.access(id, caller));
      return;
    }
    if (operation === "details" && method === "GET") {
      respond(res, 200, { details: await options.service.details(id, caller) });
      return;
    }
    if (operation === "exec" && method === "POST") {
      const body = await readJson(req);
      respond(res, 200, {
        output: await options.service.execute(
          id,
          body.args as string[],
          body.timeoutMs as number | undefined,
          caller
        )
      });
      return;
    }
    if (!operation && method === "GET") {
      respond(res, 200, { computer: options.service.get(id, caller) });
      return;
    }
    if (!operation && method === "DELETE") {
      respond(res, 200, { computer: await options.service.destroy(id, caller) });
      return;
    }
    if (operation === "start" && method === "POST") {
      respond(res, 200, { computer: await options.service.start(id, caller) });
      return;
    }
    if (operation === "stop" && method === "POST") {
      respond(res, 200, { computer: await options.service.stop(id, caller) });
      return;
    }
    if (operation === "restart" && method === "POST") {
      respond(res, 200, { computer: await options.service.restart(id, caller) });
      return;
    }
  }

  throw new CloudError(404, "ROUTE_NOT_FOUND", "Route not found");
}

/** An account sees only allocations on computers it owns. */
function visibleAllocations<T extends { computerId: string }>(
  allocations: T[],
  caller: Caller,
  options: CloudHttpOptions
): T[] {
  if (caller.kind === "operator") return allocations;
  return allocations.filter(allocation => {
    try {
      options.service.get(allocation.computerId, caller);
      return true;
    } catch {
      return false;
    }
  });
}

function requireOperator(caller: Caller): void {
  if (caller.kind !== "operator") {
    throw new CloudError(403, "OPERATOR_REQUIRED", "Operator credential required");
  }
}

/**
 * The operator token wins outright; otherwise the token is looked up as an
 * account. A disabled account is refused even with a valid token.
 */
export function authenticate(req: IncomingMessage, options: CloudHttpOptions): Caller {
  const token = bearerToken(req);
  if (token.length === 0) {
    throw new CloudError(401, "UNAUTHORIZED", "Valid bearer token required");
  }
  if (tokenMatches(token, options.operatorToken)) {
    return OPERATOR;
  }
  const account = options.accountStore?.findByToken(token);
  if (!account) {
    throw new CloudError(401, "UNAUTHORIZED", "Valid bearer token required");
  }
  if (account.status !== "active") {
    throw new CloudError(403, "ACCOUNT_DISABLED", "This account is disabled");
  }
  return { kind: "account", account };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) {
      throw new CloudError(413, "REQUEST_BODY_TOO_LARGE", "Request body too large");
    }
    chunks.push(buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
    return body as Record<string, unknown>;
  } catch {
    throw new CloudError(400, "INVALID_JSON", "Expected a JSON object");
  }
}

function respond(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export type WorkerTarget = { user: string; host: string };

/**
 * The workers this control plane drives, as `user@host`.
 *
 * `SYNTRUM_WORKERS` is a comma-separated list; the older single-worker pair is
 * the fallback, so every existing deployment and acceptance harness keeps
 * working unchanged. The list is validated, not trusted: these values become
 * an SSH destination and a map key for every computer on that worker.
 */
export function parseWorkerTargets(env: NodeJS.ProcessEnv = process.env): WorkerTarget[] {
  const listed = (env.SYNTRUM_WORKERS ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const raw = listed.length > 0
    ? listed
    : [`${env.SYNTRUM_WORKER_SSH_USER ?? ""}@${env.SYNTRUM_WORKER_SSH_HOST ?? ""}`];

  const targets = raw.map(entry => {
    const separator = entry.lastIndexOf("@");
    const user = separator > 0 ? entry.slice(0, separator) : "";
    const host = separator > 0 ? entry.slice(separator + 1) : "";
    if (!user || !host) {
      throw new Error(`Worker must be in user@host form: ${entry}`);
    }
    return { user, host };
  });
  // A duplicate host would make one machine's computers route to the other's
  // driver, so it is refused rather than silently collapsed.
  const hosts = new Set(targets.map(target => `${target.user}@${target.host}`));
  if (hosts.size !== targets.length) {
    throw new Error("SYNTRUM_WORKERS lists the same worker more than once");
  }
  return targets;
}

async function main(): Promise<void> {
  const targets = parseWorkerTargets();
  const knownHostsPath = process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS;
  const identityFile = process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE;
  // The worker clock is skewed on some deployments, which makes apt reject its
  // own Release files. This override is opt-in and relaxes only the date check.
  const aptConf = process.env.SYNTRUM_WORKER_APT_CONF;
  const databasePath = process.env.CLOUD_AI_OS_DB_PATH ?? resolve(process.cwd(), "data/cloud.sqlite");
  const workerStore = new WorkerStore(databasePath);

  const drivers = new Map<string, IncusWorkerDriver>();
  const gpuAgents = new Map<string, NvidiaWorkerAgent>();
  for (const target of targets) {
    const run = createSshCommandRunner({
      host: target.host,
      user: target.user,
      knownHostsPath,
      identityFile
    });
    const workerHost = `${target.user}@${target.host}`;
    drivers.set(workerHost, new IncusWorkerDriver(run, undefined, undefined, aptConf));
    gpuAgents.set(workerHost, new NvidiaWorkerAgent(run));
    try {
      workerStore.register(await checkWorkerHealth(run, target.host, target.user));
    } catch (error) {
      // The first worker is the default and is required: starting without it
      // would serve a control plane whose computers can never be created, which
      // is a broken configuration rather than a degraded one, so it still fails
      // loudly. A later worker that is briefly down must not take the default
      // worker's computers with it, so it is recorded as unavailable and its
      // computers fail with the driver's own error — the honest report.
      if (target === targets[0]) throw error;
      const now = new Date().toISOString();
      workerStore.register({
        id: workerHost,
        host: target.host,
        sshUser: target.user,
        architecture: "unknown",
        incusVersion: "unknown",
        status: "unavailable",
        lastSeenAt: now,
        createdAt: now
      });
      console.warn(
        `Worker ${workerHost} is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const defaultWorker = `${targets[0].user}@${targets[0].host}`;
  const store = new CloudComputerStore(databasePath);
  const service = new CloudComputerService({
    store,
    driver: drivers.get(defaultWorker)!,
    drivers,
    workerHost: defaultWorker,
    desktopEnabled: process.env.SYNTRUM_DESKTOP_ENABLED !== "false"
  });
  const gpuScheduler = new GpuScheduler(new GpuStore(databasePath), store, gpuAgents);
  await service.reconcile();
  await gpuScheduler.recover();
  const server = createCloudHttpServer({
    service,
    gpuScheduler,
    workerStore,
    accountStore: new AccountStore(databasePath),
    operatorToken: requiredEnvironment("CLOUD_AI_OS_OPERATOR_TOKEN")
  });
  server.listen(4318, "127.0.0.1", () => {
    console.log("SYNTRUM cloud control plane listening on http://127.0.0.1:4318");
  });

  // The browser surface runs as its own process (`src/cloud/browser-ui.ts`), so
  // the control plane keeps a bearer-only contract and the UI is the only place
  // that exchanges that token for a cookie. It also owns the desktop gateway,
  // because the WebSocket upgrade needs the session cookie this server does
  // not issue. Start it separately; do not mount it here.
  const shutdown = () => server.close(() => {
    gpuScheduler.close();
    workerStore.close();
    service.close();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
