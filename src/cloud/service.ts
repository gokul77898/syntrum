import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { OPERATOR, ownsComputer, newAccountToken, type Caller } from "./accounts.js";
import { guestSocketPath } from "./guest-bridge.js";
import { CloudComputerStore } from "./store.js";
import {
  CloudError,
  type CloudComputer,
  type ComputerSpec,
  type CreateComputerInput,
  type ForkComputerInput,
  type GuestRuntimeProvisioner,
  type WorkerDriver
} from "./types.js";

const runFile = promisify(execFile);

/** Single-quotes for a remote shell; embedded quotes are closed and reopened. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_DISK_GB = 40;
// Must match the driver's image: only the /cloud variant ships cloud-init.
const DEFAULT_IMAGE = "images:ubuntu/24.04/cloud";
// The guest runtime needs node:sqlite, which Ubuntu 24.04's nodejs (18.19) does
// not have. Kept in step with the acceptance harnesses' default.
const DEFAULT_GUEST_NODE_VERSION = "v26.13.0";
// Installing Node is a download and an unpack; the daemon upload is a copy.
const GUEST_RUNTIME_TIMEOUT_MS = 15 * 60_000;
// Base64 characters per upload command. 60 KiB keeps a single argv element well
// inside the limit `execve` imposes, with room for the shell and the path.
const UPLOAD_CHUNK_CHARS = 60 * 1024;

function* chunksOf(value: string, size: number): Generator<string> {
  for (let index = 0; index < value.length; index += size) {
    yield value.slice(index, index + size);
  }
}

export type CloudComputerServiceOptions = {
  store: CloudComputerStore;
  driver: WorkerDriver;
  workerHost: string;
  /**
   * Per-worker drivers, keyed by `user@host`. When absent every computer uses
   * `driver`, which is what the single-worker callers (and every existing test)
   * mean. When present, a computer's own `workerHost` selects its driver.
   */
  drivers?: ReadonlyMap<string, WorkerDriver>;
  /**
   * Installs the guest agent runtime (Node + the bus daemon) during create().
   *
   * Optional so the deterministic tests and the desktop-only harnesses stay
   * fast and offline: when absent, create() provisions no guest runtime and
   * agentAccess reports the bus as not provisioned. When present, a computer
   * is only reported "running" once its bus socket is verified live.
   */
  guestProvisioner?: GuestRuntimeProvisioner;
  /** Node version for the guest runtime; defaults to DEFAULT_GUEST_NODE_VERSION. */
  guestNodeVersion?: string;
  desktopEnabled?: boolean;
  /** Per-account ceiling; undefined uses each account's own maxComputers. */
  accountComputerLimit?: number;
};

export class CloudComputerService {
  private readonly store: CloudComputerStore;
  private readonly driver: WorkerDriver;
  private readonly drivers?: ReadonlyMap<string, WorkerDriver>;
  private readonly guestProvisioner?: GuestRuntimeProvisioner;
  private readonly guestNodeVersion: string;
  private readonly workerHost: string;
  private readonly desktopEnabled: boolean;
  private readonly accountComputerLimit?: number;
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(options: CloudComputerServiceOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.drivers = options.drivers;
    this.guestProvisioner = options.guestProvisioner;
    this.guestNodeVersion = options.guestNodeVersion ?? DEFAULT_GUEST_NODE_VERSION;
    this.workerHost = options.workerHost;
    this.desktopEnabled = options.desktopEnabled !== false;
    this.accountComputerLimit = options.accountComputerLimit;
  }

  /**
   * The driver that owns a given worker.
   *
   * A computer recorded on a worker the registry does not know about is a
   * configuration error, not something to quietly run on the wrong host: the
   * command would name a container that does not exist there. Single-worker
   * callers have no registry, so every host maps to the one driver.
   */
  private driverFor(workerHost: string): WorkerDriver {
    if (!this.drivers) return this.driver;
    const driver = this.drivers.get(workerHost);
    if (!driver) {
      throw new CloudError(
        503,
        "WORKER_NOT_REGISTERED",
        `No driver is configured for worker ${workerHost}`
      );
    }
    return driver;
  }

  /** The workers a new computer may be created on. */
  private knownWorkerHosts(): string[] {
    return this.drivers ? [...this.drivers.keys()] : [this.workerHost];
  }

  /**
   * Without a caller this is the operator's own view, which is what every
   * pre-accounts caller (acceptance harnesses, tests) means.
   */
  list(caller: Caller = OPERATOR): CloudComputer[] {
    return this.store.list(
      caller.kind === "operator" ? {} : { ownerId: caller.account.id }
    );
  }

  get(id: string, caller: Caller = OPERATOR): CloudComputer {
    this.validateId(id);
    return this.requireAccess(id, caller);
  }

  async create(input: CreateComputerInput = {}, caller: Caller = OPERATOR): Promise<CloudComputer> {
    const id = randomUUID();
    const cpu = input.cpu ?? DEFAULT_CPU;
    const memoryMb = input.memoryMb ?? DEFAULT_MEMORY_MB;
    const diskGb = input.diskGb ?? DEFAULT_DISK_GB;
    if (!Number.isSafeInteger(cpu) || cpu < 1 || cpu > 64) {
      throw new CloudError(400, "INVALID_CPU", "CPU must be between 1 and 64");
    }
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 512 || memoryMb > 262_144) {
      throw new CloudError(400, "INVALID_MEMORY", "Memory must be between 512 and 262144 MiB");
    }
    if (!Number.isSafeInteger(diskGb) || diskGb < 5 || diskGb > 2048) {
      throw new CloudError(400, "INVALID_DISK", "Disk must be between 5 and 2048 GiB");
    }

    // The limit comes from the account record, never from the request, so a
    // caller cannot raise their own ceiling.
    this.assertCreateQuota(caller, input);

    // A caller may name a worker, but only one that is actually registered —
    // otherwise the container would be created in the control plane's records
    // and nowhere else.
    const workerHost = input.workerHost ?? this.workerHost;
    if (!this.knownWorkerHosts().includes(workerHost)) {
      throw new CloudError(
        400,
        "WORKER_NOT_REGISTERED",
        `Unknown worker ${workerHost}; known workers: ${this.knownWorkerHosts().join(", ")}`
      );
    }

    const now = new Date().toISOString();
    const desktopEnabled = this.desktopEnabled && input.desktopEnabled !== false;
    const spec: ComputerSpec = {
      id,
      workerHost,
      image: DEFAULT_IMAGE,
      cpu,
      memoryMb,
      diskGb,
      storageVolume: `syntrum-workspace-${id}`,
      desktopPort: this.store.nextDesktopPort(),
      desktopEnabled
    };
    this.store.insert({
      ...spec,
      desktopEnabled,
      ...(caller.kind === "account" ? { ownerId: caller.account.id } : {}),
      status: "provisioning",
      createdAt: now,
      updatedAt: now
    });
    return this.runExclusive(id, async () => {
      const driver = this.driverFor(spec.workerHost);
      try {
        await driver.create(spec);
        // A requested desktop that never came up must not report "running".
        // The container is deliberately left in place so it can be inspected.
        if (desktopEnabled) {
          await driver.verifyDesktop?.(id);
        }
        // The guest runtime goes in before the status flips, so "running" means
        // the desktop and the agent bus are both actually up. installBus only
        // returns once it has proved the unit active, the socket present and the
        // daemon ready, so the token is recorded then and never before.
        if (this.guestProvisioner) {
          const token = newAccountToken();
          await this.provisionGuestRuntime(driver, id, token);
          this.store.setGuestAgentToken(id, token);
        }
        return this.store.updateStatus(id, "running");
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_CREATE_FAILED", this.message(error), { computerId: id });
      }
    });
  }

  /**
   * Installs Node and the agent bus in a freshly created guest.
   *
   * The image is compiled here and pushed through the running container, which
   * is the only transport that works for every worker: the acceptance harness
   * could scp to a worker because it ran on the operator's machine, but the
   * control plane may have no filesystem access to the worker at all.
   */
  private async provisionGuestRuntime(
    driver: WorkerDriver,
    id: string,
    token: string
  ): Promise<void> {
    const provisioner = this.guestProvisioner!;
    if (!driver.execute) {
      throw new Error(
        "The worker does not expose guest execution, which the guest agent " +
        "runtime needs to install Node and the bus"
      );
    }
    // A compiled copy per computer, because each gets its own agent grant and
    // the daemon is configured from the unit's environment file.
    const staging = await mkdtemp(join(tmpdir(), "syntrum-guest-runtime-"));
    try {
      const compiled = await provisioner.compile(staging);
      // installNode first: installBus proves Node exists and otherwise names it
      // as the missing prerequisite, which is a less obvious failure.
      await provisioner.installNode(id, this.guestNodeVersion);
      await provisioner.installBus(id, {
        compiledDirectory: compiled.directory,
        // One agent per computer, and the id is derived here rather than taken
        // from the request, so a caller cannot aim a grant at another guest.
        agents: [{ id, token }],
        upload: async (_id, localDirectory, remoteDirectory) => {
          await driver.execute!(id, ["mkdir", "-p", remoteDirectory], 60_000);
          await this.pushDirectory(driver, id, localDirectory, remoteDirectory);
        }
      });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Copies a local directory tree into the guest.
   *
   * `incus file push <src> <instance><path>` resolves `src` on the *worker*,
   * not on the caller, so it cannot be used from here. The tree is tarred
   * locally and written through the guest's own shell as base64 instead, which
   * needs no filesystem access to the worker and no new transport.
   */
  private async pushDirectory(
    driver: WorkerDriver,
    id: string,
    localDirectory: string,
    remoteDirectory: string
  ): Promise<void> {
    const archive = join(tmpdir(), `syntrum-upload-${randomUUID()}.tar.gz`);
    const staged = `/tmp/syntrum-upload-${randomUUID()}.b64`;
    try {
      await runFile("tar", ["-czf", archive, "-C", localDirectory, "."]);
      const payload = (await readFile(archive)).toString("base64");

      // One command per chunk: a single argv element is bounded by the local
      // ARG_MAX, and the daemon's closure is a few hundred KB once base64 has
      // inflated it. The base64 alphabet needs no escaping beyond quoting.
      for (const chunk of chunksOf(payload, UPLOAD_CHUNK_CHARS)) {
        await driver.execute!(
          id,
          ["sh", "-c", `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(staged)}`],
          GUEST_RUNTIME_TIMEOUT_MS
        );
      }
      // Decoding and extraction are one command so a failure cannot leave a
      // half-populated /opt/syntrum that installBus would then call present.
      // `-d < file` rather than `-d file`: the positional form is GNU-only, and
      // reading the file on stdin is accepted by both implementations.
      await driver.execute!(
        id,
        ["sh", "-c",
          `base64 -d < ${shellQuote(staged)} | tar -xzf - -C ${shellQuote(remoteDirectory)}` +
          ` && rm -f ${shellQuote(staged)}`],
        GUEST_RUNTIME_TIMEOUT_MS
      );
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
    }
  }

  start(id: string, caller: Caller = OPERATOR): Promise<CloudComputer> {
    return this.transition(id, "starting", driver => driver.start(id), "running", caller);
  }

  stop(id: string, caller: Caller = OPERATOR): Promise<CloudComputer> {
    return this.transition(id, "stopping", driver => driver.stop(id), "stopped", caller);
  }

  restart(id: string, caller: Caller = OPERATOR): Promise<CloudComputer> {
    return this.transition(id, "restarting", driver => driver.restart(id), "running", caller);
  }

  destroy(id: string, caller: Caller = OPERATOR): Promise<CloudComputer> {
    this.validateId(id);
    return this.runExclusive(id, async () => {
      // Checked inside the exclusive section so a deleted-then-read race cannot
      // reveal another account's record.
      const computer = this.requireAccess(id, caller);
      if (computer.status === "deleted") {
        return computer;
      }
      this.store.updateStatus(id, "deleting");
      try {
        await this.driverFor(computer.workerHost).destroy(computer);
        return this.store.updateStatus(id, "deleted");
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_DESTROY_FAILED", this.message(error));
      }
    });
  }

  details(id: string, caller: Caller = OPERATOR) {
    this.validateId(id);
    // Ownership first: answering "details not supported" to a non-owner would
    // confirm the ID exists, which the 404 below is meant to hide.
    const computer = this.requireAccess(id, caller);
    const driver = this.driverFor(computer.workerHost);
    if (!driver.inspectDetails) {
      throw new CloudError(501, "DETAILS_NOT_SUPPORTED", "Worker does not expose resource details");
    }
    return driver.inspectDetails(id);
  }

  /**
   * Branches a computer: the target is a full copy of the source's disk, which
   * is what makes it useful for trying a risky change and throwing it away.
   *
   * The source must be stopped first — Incus cannot copy a running instance
   * without a snapshot, and a snapshot of a moving filesystem is not a
   * faithful branch of the workspace.
   */
  async fork(sourceId: string, input: ForkComputerInput = {}, caller: Caller = OPERATOR): Promise<CloudComputer> {
    this.validateId(sourceId);
    const source = this.requireAccess(sourceId, caller);
    // Resolved from the source below, never from the request: a fork must stay
    // on the worker holding the disk it is copying.
    const driver = this.driverFor(source.workerHost);
    if (!driver.fork) {
      throw new CloudError(501, "FORK_NOT_SUPPORTED", "Worker does not support forking computers");
    }
    if (source.status !== "stopped") {
      throw new CloudError(
        409,
        "SOURCE_NOT_STOPPED",
        `Stop the computer before forking it; it is ${source.status}`
      );
    }
    this.assertCreateQuota(caller, input);

    const id = randomUUID();
    const now = new Date().toISOString();
    const spec: ComputerSpec = {
      id,
      // The copy reads the source's disk, so it can only happen on that worker.
      workerHost: source.workerHost,
      image: source.image,
      cpu: input.cpu ?? source.cpu,
      memoryMb: input.memoryMb ?? source.memoryMb,
      diskGb: input.diskGb ?? source.diskGb,
      // A fork gets its own volume name; `incus copy` already carries the root
      // filesystem, so the source's workspace volume is not double-attached.
      storageVolume: `syntrum-workspace-${id}`,
      desktopPort: this.store.nextDesktopPort(),
      desktopEnabled: input.desktopEnabled ?? source.desktopEnabled
    };
    this.store.insert({
      ...spec,
      desktopEnabled: spec.desktopEnabled ?? true,
      ...(source.ownerId ? { ownerId: source.ownerId } : {}),
      status: "provisioning",
      createdAt: now,
      updatedAt: now
    });
    return this.runExclusive(id, async () => {
      try {
        // A fork replaces the container's own storage: the copied root
        // filesystem already holds everything, so no new volume is created.
        await driver.fork!(sourceId, id);
        return this.store.updateStatus(id, "running");
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_FORK_FAILED", this.message(error), { computerId: id });
      }
    });
  }

  execute(id: string, args: readonly string[], timeoutMs?: number, caller: Caller = OPERATOR): Promise<string> {
    this.validateId(id);
    const computer = this.requireAccess(id, caller);
    if (computer.status !== "running") {
      throw new CloudError(409, "COMPUTER_NOT_RUNNING", "Cloud computer must be running");
    }
    const driver = this.driverFor(computer.workerHost);
    if (!driver.execute) {
      throw new CloudError(501, "EXEC_NOT_SUPPORTED", "Worker does not expose guest execution");
    }
    if (
      args.length === 0 ||
      args.length > 32 ||
      args.some(value => typeof value !== "string" || value.length === 0 || value.length > 4096)
    ) {
      throw new CloudError(400, "INVALID_COMMAND", "Invalid guest command");
    }
    return driver.execute(id, args, timeoutMs);
  }

  access(id: string, caller: Caller = OPERATOR) {
    const computer = this.requireAccess(id, caller);
    if (computer.status !== "running") {
      throw new CloudError(409, "DESKTOP_NOT_READY", "Cloud desktop is not running");
    }
    if (!computer.desktopEnabled) {
      throw new CloudError(409, "DESKTOP_NOT_PROVISIONED", "This computer has no desktop");
    }
    const localUrl = `http://127.0.0.1:${computer.desktopPort}/vnc.html`;
    return {
      computerId: id,
      protocol: "noVNC over SSH tunnel",
      // The computer's own worker, not the default one: with several workers a
      // tunnel to the default host reaches nothing at all.
      sshTunnelCommand: `ssh -L ${computer.desktopPort}:127.0.0.1:${computer.desktopPort} ${computer.workerHost}`,
      browserUrlAfterTunnel: localUrl,
      publicExposure: false
    };
  }

  /**
   * Where an agent connects to reach this computer's workspace.
   *
   * The socket path is derived from the computer id here, not supplied by the
   * caller, so a request cannot aim a tunnel at another guest. The workspace is
   * reported as the single shared id agents already use.
   *
   * A computer with no guest runtime is refused rather than handed a socket path
   * that nothing is listening on — that failure is otherwise indistinguishable
   * from a broken tunnel. The token is returned because the bus demands a valid
   * grant; it is read from the store, the only place it exists.
   */
  agentAccess(id: string, caller: Caller = OPERATOR) {
    const computer = this.requireAccess(id, caller);
    if (computer.status !== "running") {
      throw new CloudError(409, "COMPUTER_NOT_RUNNING", "Cloud computer must be running to reach its workspace");
    }
    const token = this.store.guestAgentToken(id);
    if (!token) {
      throw new CloudError(
        409,
        "GUEST_BUS_NOT_PROVISIONED",
        "This computer has no guest agent bus; it was created without guest provisioning"
      );
    }
    return {
      computerId: id,
      protocol: "SYNTRUM agent bus over an SSH unix-socket tunnel",
      socketPath: guestSocketPath(id),
      // One agent per computer, named after the computer itself.
      agent: { id, token },
      workspaceId: "main",
      workspaceRoot: "/workspace",
      workerHost: computer.workerHost,
      publicExposure: false
    };
  }

  async reconcile(): Promise<CloudComputer[]> {
    for (const computer of this.store.list()) {
      try {
        const status = await this.driverFor(computer.workerHost).inspect(computer.id);
        this.store.updateStatus(computer.id, status);
      } catch (error) {
        this.store.updateStatus(computer.id, "error", this.message(error));
      }
    }
    return this.store.list();
  }

  close(): void {
    this.store.close();
  }

  private async transition(
    id: string,
    pending: CloudComputer["status"],
    operation: (driver: WorkerDriver) => Promise<void>,
    completed: CloudComputer["status"],
    caller: Caller = OPERATOR
  ): Promise<CloudComputer> {
    this.validateId(id);
    return this.runExclusive(id, async () => {
      const computer = this.requireAccess(id, caller);
      this.store.updateStatus(id, pending);
      try {
        await operation(this.driverFor(computer.workerHost));
        return this.store.updateStatus(id, completed);
      } catch (error) {
        this.store.updateStatus(id, "error", this.message(error));
        throw new CloudError(502, "WORKER_OPERATION_FAILED", this.message(error));
      }
    });
  }

  /**
   * A new computer (created or forked) spends the owner's quota. Read from the
   * account record, never from the request, so a caller cannot raise their own
   * ceiling.
   */
  private assertCreateQuota(caller: Caller, input: CreateComputerInput | ForkComputerInput): void {
    void input;
    if (caller.kind !== "account") {
      return;
    }
    if (caller.account.status !== "active") {
      throw new CloudError(403, "ACCOUNT_DISABLED", "This account is disabled");
    }
    const limit = this.accountComputerLimit ?? caller.account.maxComputers;
    const existing = this.store.list({ ownerId: caller.account.id }).length;
    if (existing >= limit) {
      throw new CloudError(
        429,
        "COMPUTER_LIMIT_REACHED",
        `Account limit of ${limit} computers reached`
      );
    }
  }

  private runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.operations.set(id, result);
    void result.finally(() => {
      if (this.operations.get(id) === result) {
        this.operations.delete(id);
      }
    }).catch(() => undefined);
    return result;
  }

  /**
   * Another account's computer is reported as missing rather than forbidden, so
   * a caller cannot use the difference to learn which IDs exist. Only after
   * ownership passes does a deleted computer report as deleted, which the owner
   * is entitled to know.
   */
  private requireAccess(id: string, caller: Caller = OPERATOR): CloudComputer {
    const computer = this.store.get(id);
    if (!ownsComputer(caller, computer.ownerId ?? null)) {
      throw new CloudError(404, "COMPUTER_NOT_FOUND", "Cloud computer not found");
    }
    if (computer.status === "deleted") {
      throw new CloudError(409, "COMPUTER_DELETED", "Cloud computer has been deleted");
    }
    return computer;
  }

  private validateId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new CloudError(400, "INVALID_COMPUTER_ID", "Invalid cloud computer ID");
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : "Remote worker operation failed";
  }
}
