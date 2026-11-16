// Live acceptance for Phase 4: an agent reaches a real guest's /workspace over
// the SSH unix-socket bridge, with the workspace's real versioned write path.
//
// Opt-in and destructive to its own resources only. It creates one temporary
// container, installs Node and the guest bus, drives MCP-shaped tool calls over
// the bridge, and deletes everything it created.
//
//   SYNTRUM_WORKER_SSH_HOST=... SYNTRUM_WORKER_SSH_USER=... \
//   npm run test:live-agents
//
// What it proves, and what it does not:
//   - the guest bus starts under systemd and serves its socket
//   - an agent grant authenticates over the SSH tunnel
//   - a write reaches the guest's own /workspace on disk
//   - a stale-version write is rejected and leaves the file untouched
//   - a change made outside the bus (as the human's editor would) is announced
// It does not prove an IDE is editing the same file: no editor is installed in
// the guest. That needs the desktop image and is a separate acceptance run.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CloudComputerService,
  CloudComputerStore,
  GuestProvisioner,
  IncusWorkerDriver,
  createSshCommandRunner,
  guestSocketPath,
  isIncusNotFound,
  GuestBusClient
} from "../cloud/index.js";
import { errorMessage } from "../runtime/errors.js";

const runFile = promisify(execFile);
const NODE_VERSION = process.env.SYNTRUM_GUEST_NODE_VERSION ?? "v26.13.0";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} required`);
  }
  return value;
}

const evidence: Record<string, unknown> = { status: "STARTED", nodeVersion: NODE_VERSION };

const AGENT = {
  id: "acceptance-agent",
  // Generated per run rather than fixed, so a leaked log from one run cannot
  // authenticate against a later one.
  token: process.env.SYNTRUM_AGENT_TOKEN ?? `acc-${Math.random().toString(36).slice(2)}${Date.now()}`
};

async function main(): Promise<void> {
  const run = createSshCommandRunner({
    host: required("SYNTRUM_WORKER_SSH_HOST"),
    user: required("SYNTRUM_WORKER_SSH_USER"),
    knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
    identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
  });
  const driver = new IncusWorkerDriver(
    run, undefined, undefined, process.env.SYNTRUM_WORKER_APT_CONF
  );
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-agents-live-"));
  const store = new CloudComputerStore(join(dataRoot, "cloud.sqlite"));
  const service = new CloudComputerService({
    store, driver, workerHost: "gokul@worker", desktopEnabled: false
  });
  const provisioner = new GuestProvisioner(
    async (id, args, timeoutMs) => (await driver.execute?.(id, args, timeoutMs)) ?? "",
    Boolean(process.env.SYNTRUM_WORKER_APT_CONF)
  );

  let computerId: string | undefined;
  let client: GuestBusClient | undefined;
  let failed = false;

  try {
    const computer = await service.create({
      cpu: 1, memoryMb: 1024, diskGb: 5, desktopEnabled: false
    });
    computerId = computer.id;
    evidence.created = { id: computer.id, status: computer.status };

    evidence.beforeVersion = await driver.execute?.(computerId, ["node", "--version"])
      .then(value => value.trim() || "(empty)")
      .catch(error => `(unavailable: ${errorMessage(error, "failed")})`);

    await provisioner.installNode(computerId, NODE_VERSION);
    evidence.nodeInstalled = true;

    // Compile the guest daemon on this host: the guest has no toolchain, and
    // Node's type stripping cannot run the bus (it uses constructor parameter
    // properties). The compiled output has no dependencies.
    const compiled = await compileGuestModules(dataRoot);
    evidence.compiledModules = compiled.modules;

    await provisioner.installBus(computerId, {
      compiledDirectory: compiled.directory,
      agents: [AGENT],
      upload: async (id, localDirectory, remoteDirectory) => {
        // The agent-bus proxy device is what makes the socket dialable from the
        // worker; create() already added it for this computer.
        evidence.socketPath = guestSocketPath(id);
        await run(["test", "-d", remoteDirectory], 30_000);
        await driver.execute?.(id, ["mkdir", "-p", remoteDirectory], 30_000);
        // The container directory is reached through the worker, so the files
        // are copied to the worker first and then pushed with incus file.
        const staging = join(dataRoot, "staging");
        await mkdir(staging, { recursive: true });
        await copyDirectory(localDirectory, staging);
        const remote = `${required("SYNTRUM_WORKER_SSH_USER")}@${required("SYNTRUM_WORKER_SSH_HOST")}`;
        await runFile("scp", ["-q", "-r", `${staging}/.`, `${remote}:/tmp/syntrum-bus-${id}`], {
          timeout: 120_000
        });
        await run([
          "incus", "file", "push", "--recursive", `/tmp/syntrum-bus-${id}/.`,
          `${id}${remoteDirectory}`
        ], 180_000);
      }
    });
    evidence.busInstalled = true;

    // ── The agent side: connect over the SSH tunnel ──────────────────────
    client = await GuestBusClient.connect({
      computerId,
      agent: AGENT,
      ssh: {
        host: required("SYNTRUM_WORKER_SSH_HOST"),
        user: required("SYNTRUM_WORKER_SSH_USER"),
        knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
        identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
      }
    });
    evidence.connected = { agentId: client.agentId, capabilities: [...client.capabilities] };

    // 1. Write a file through the agent bus.
    const path = "agent-note.txt";
    const written = await client.writeFile({
      sessionId: "main", path, content: "written by an agent\n",
      encoding: "utf8", expectedVersion: null
    });
    evidence.write = { path, version: written.version };

    // 2. Prove the file is on the guest's real disk, read by a separate exec
    //    rather than by the bus that wrote it.
    const onDisk = (await driver.execute?.(computerId, ["cat", `/workspace/${path}`]) ?? "").trim();
    evidence.fileOnGuestDisk = onDisk;
    if (onDisk !== "written by an agent") {
      throw new Error(`Guest /workspace did not receive the write; read '${onDisk}'`);
    }

    // 3. A change outside the bus must be visible to a later read, which is
    //    what makes the workspace genuinely shared rather than agent-only.
    await driver.execute?.(computerId, [
      "sh", "-c", "printf 'edited outside the bus\\n' > /workspace/human-edit.txt"
    ], 30_000);
    const external = await client.readFile({ sessionId: "main", path: "human-edit.txt" });
    evidence.externalChangeVisible = external.content.trim();
    if (external.content.trim() !== "edited outside the bus") {
      throw new Error("A file written outside the bus was not readable through it");
    }

    // 4. Stale-version rejection: read, let another writer move it, then write
    //    with the version we no longer hold.
    const read = await client.readDocument({
      sessionId: "main", workspaceId: "main", path
    });
    await client.writeFile({
      sessionId: "main", path, content: "second writer\n", encoding: "utf8",
      expectedVersion: written.version
    });
    let conflict: string | undefined;
    try {
      await client.writeDocument({
        sessionId: "main", workspaceId: "main", path,
        text: "stale write\n", expectedVersion: read.document.version
      });
    } catch (error) {
      conflict = (error as { code?: string }).code;
    }
    evidence.staleVersionRejected = conflict;
    if (conflict !== "VERSION_CONFLICT") {
      throw new Error(`Expected VERSION_CONFLICT, got ${conflict ?? "no error"}`);
    }
    const afterConflict = (await driver.execute?.(computerId, ["cat", `/workspace/${path}`]) ?? "").trim();
    evidence.fileAfterConflict = afterConflict;
    if (afterConflict !== "second writer") {
      throw new Error("The rejected write modified the file");
    }

    // 5. A grant the guest does not know must not connect.
    let rejected = false;
    try {
      const stranger = await GuestBusClient.connect({
        computerId, agent: { id: AGENT.id, token: "not-the-right-token" },
        ssh: {
          host: required("SYNTRUM_WORKER_SSH_HOST"),
          user: required("SYNTRUM_WORKER_SSH_USER"),
          knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
          identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
        }
      });
      await stranger.close();
    } catch {
      rejected = true;
    }
    evidence.wrongTokenRejected = rejected;
    if (!rejected) {
      throw new Error("A wrong token connected to the guest bus");
    }

    evidence.status = "PASSED";
  } catch (error) {
    failed = true;
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    await client?.close().catch(() => undefined);
    if (computerId && failed && process.env.SYNTRUM_KEEP_FAILED === "1") {
      evidence.cleanup = { container: "kept for inspection", id: computerId };
    } else if (computerId) {
      try {
        await service.destroy(computerId);
        const gone = await driver.inspect(computerId).catch(error => {
          if (isIncusNotFound(error)) return "deleted";
          throw error;
        });
        evidence.cleanup = { container: gone };
      } catch (error) {
        evidence.cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    service.close();
  }

  console.log(JSON.stringify(evidence, null, 2));
  if (failed) {
    process.exitCode = 1;
  }
}

async function copyDirectory(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
}

/** Compiles the bus and its closure to plain JavaScript for the guest. */
async function compileGuestModules(dataRoot: string): Promise<{ directory: string; modules: string }> {
  const outDir = join(dataRoot, "compiled");
  const { stderr } = await runFile("npx", [
    "tsc", "--outDir", outDir, "--rootDir", "src",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022"
  ], { timeout: 300_000 });
  if (stderr.trim()) {
    evidence.tscWarnings = stderr.trim().split("\n").slice(0, 3);
  }
  // Only the modules the daemon imports are shipped; the rest of the host
  // runtime would be dead weight inside the guest.
  for (const relative of ["guest", "bus", "adapters"]) {
    await mkdir(join(outDir, relative), { recursive: true });
  }
  await writeFile(join(outDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  return { directory: outDir, modules: "guest/bus-daemon" };
}

await main();
