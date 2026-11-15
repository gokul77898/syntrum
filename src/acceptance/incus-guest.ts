// Live acceptance for the guest provisioner: install Node 26 in a throwaway
// guest and prove the runtime's actual requirement (node:sqlite) works there.
//
// Opt-in and destructive to its own resources only. It creates one temporary
// container, installs Node, verifies it, and deletes everything it created.
//
//   SYNTRUM_WORKER_SSH_HOST=... SYNTRUM_WORKER_SSH_USER=... \
//   npm run test:live-guest
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import {
  CloudComputerService,
  CloudComputerStore,
  GuestProvisioner,
  IncusWorkerDriver,
  createSshCommandRunner,
  isIncusNotFound
} from "../cloud/index.js";
import { errorMessage } from "../runtime/errors.js";

const NODE_VERSION = process.env.SYNTRUM_GUEST_NODE_VERSION ?? "v26.13.0";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} required`);
  }
  return value;
}

const evidence: Record<string, unknown> = { status: "STARTED", nodeVersion: NODE_VERSION };

async function main(): Promise<void> {
  const run = createSshCommandRunner({
    host: required("SYNTRUM_WORKER_SSH_HOST"),
    user: required("SYNTRUM_WORKER_SSH_USER"),
    knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
    identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
  });
  // The packages the install script insists on; the desktop path installs
  // these too, so a desktop-enabled computer needs no extra bootstrap.
  const driver = new IncusWorkerDriver(
    run, undefined, undefined, process.env.SYNTRUM_WORKER_APT_CONF
  );
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-guest-live-"));
  const store = new CloudComputerStore(join(dataRoot, "cloud.sqlite"));
  const service = new CloudComputerService({
    store, driver, workerHost: "gokul@worker", desktopEnabled: false
  });
  const provisioner = new GuestProvisioner(
    async (id, args, timeoutMs) => (await driver.execute?.(id, args, timeoutMs)) ?? ""
  );

  let computerId: string | undefined;
  let failed = false;

  try {
    // No desktop: this proves the Node path alone, without the 800-package
    // XFCE install that would dominate the run.
    const computer = await service.create({
      cpu: 1, memoryMb: 1024, diskGb: 5, desktopEnabled: false
    });
    computerId = computer.id;
    evidence.created = { id: computer.id, status: computer.status };

    // Node is expected to be absent or too old here, and the runner treats a
    // missing command as an error — so the pre-check must tolerate rejection
    // rather than assume it returns a string.
    evidence.beforeVersion = await driver.execute?.(computerId, ["node", "--version"])
      .then(value => value.trim() || "(empty)")
      .catch(error => `(unavailable: ${errorMessage(error, "failed")})`);

    // curl and xz are what the install script requires; the base image has
    // neither, so bootstrap them the way the desktop path does. A skewed worker
    // clock makes apt reject its own Release files as "not valid yet", so the
    // same opt-in date override is applied here — the same one the driver
    // passes to cloud-init.
    const aptConf = process.env.SYNTRUM_WORKER_APT_CONF;
    const aptOptions = aptConf
      ? `-o Acquire::Check-Date=false`
      : "";
    await driver.execute?.(computerId, [
      "sh", "-c",
      `apt-get ${aptOptions} update -qq && ` +
      `DEBIAN_FRONTEND=noninteractive apt-get ${aptOptions} install -y -qq curl xz-utils`
    ], 10 * 60_000);
    evidence.bootstrapped = true;

    const installed = await provisioner.installNode(computerId, NODE_VERSION);
    evidence.installed = installed;

    await provisioner.verifyNodeSqlite(computerId);
    evidence.sqliteWorks = true;

    // Read the version back through a fresh process, not the install's output.
    const reported = (await driver.execute?.(computerId, ["node", "--version"]) ?? "").trim();
    evidence.afterVersion = reported;
    if (reported !== NODE_VERSION) {
      throw new Error(`Guest reports ${reported}, expected ${NODE_VERSION}`);
    }

    evidence.status = "PASSED";
  } catch (error) {
    failed = true;
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
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

await main();
