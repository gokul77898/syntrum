// Live acceptance for Phase 3: a desktop provisioned by the API itself.
//
// This is opt-in and mutates real infrastructure. It creates one throwaway
// container with a desktop, proves the desktop is genuinely up, proves it
// survives a restart, and deletes everything it created. It never touches
// any pre-existing instance.
//
//   SYNTRUM_WORKER_SSH_HOST=... SYNTRUM_WORKER_SSH_USER=... \
//   SYNTRUM_WORKER_SSH_KNOWN_HOSTS=... npm run test:live-desktop
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
  createSshCommandRunner,
  isIncusNotFound
} from "../cloud/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} required`);
  }
  return value;
}

const evidence: Record<string, unknown> = { status: "STARTED" };

// Everything needed to explain a failure in one run instead of the next one.
async function collectDiagnostics(
  id: string,
  guest: (id: string, args: string[], timeoutMs?: number) => Promise<string>
): Promise<Record<string, unknown>> {
  const capture = async (args: string[], timeoutMs = 60_000) => {
    try {
      return await guest(id, args, timeoutMs);
    } catch (error) {
      return `UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const cloudInitLog = await capture(["tail", "-n", "60", "/var/log/cloud-init-output.log"]);
  const aptLog = await capture([
    "sh", "-c",
    "grep -hE '^(E:|Err:|W:|The following packages have unmet)' /var/log/apt/term.log | tail -20"
  ]);
  return {
    cloudInitStatus: await capture(["cloud-init", "status", "--long"]),
    cloudInitLogTail: cloudInitLog,
    cloudInitLogErrors: cloudInitLog.split("\n")
      .filter(line => /error|fail|Traceback|E:/i.test(line)).slice(0, 20),
    aptErrors: aptLog,
    units: await capture([
      "systemctl", "--no-pager", "--plain", "list-units", "syntrum-*"
    ]),
    unitStatus: await capture([
      "sh", "-c",
      "for u in syntrum-xvfb syntrum-desktop syntrum-vnc syntrum-novnc; do " +
      "printf '%s=%s\\n' \"$u\" \"$(systemctl is-active $u.service 2>&1)\"; done"
    ]),
    xvfbLog: await capture(["journalctl", "-u", "syntrum-xvfb.service", "-n", "20", "--no-pager"]),
    vncLog: await capture(["journalctl", "-u", "syntrum-vnc.service", "-n", "20", "--no-pager"])
  };
}

async function main(): Promise<void> {
  const host = required("SYNTRUM_WORKER_SSH_HOST");
  const user = required("SYNTRUM_WORKER_SSH_USER");
  const run = createSshCommandRunner({
    host,
    user,
    knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
    identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
  });
  const workerHost = `${user}@${host}`;
  // The clock override is opt-in and only reaches cloud-init's apt config.
  const driver = new IncusWorkerDriver(
    run, undefined, undefined, process.env.SYNTRUM_WORKER_APT_CONF
  );
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-desktop-live-"));
  const store = new CloudComputerStore(join(dataRoot, "cloud.sqlite"));
  const service = new CloudComputerService({
    store, driver, workerHost, desktopEnabled: true
  });

  const guest = async (id: string, args: string[], timeoutMs?: number) =>
    (await driver.execute?.(id, args, timeoutMs)) ?? "";

  let computerId: string | undefined;
  let failed = false;

  try {
    // 2 GiB is the real minimum for XFCE + x11vnc + websockify together.
    const computer = await service.create({
      cpu: 1, memoryMb: 2048, diskGb: 5, desktopEnabled: true
    });
    computerId = computer.id;
    evidence.created = {
      id: computer.id, status: computer.status, desktopEnabled: computer.desktopEnabled
    };
    if (computer.status !== "running") {
      throw new Error(`Provisioning did not reach running: ${computer.status}`);
    }

    // create() already ran verifyDesktop; re-check independently so this proof
    // does not depend on the code under test being correct.
    const units = await guest(computerId, [
      "systemctl", "is-active", "syntrum-xvfb.service", "syntrum-desktop.service",
      "syntrum-vnc.service", "syntrum-novnc.service"
    ]);
    evidence.units = units.split(/\s+/);
    if (evidence.units instanceof Array && evidence.units.some(s => s !== "active")) {
      throw new Error(`Not all desktop units are active: ${units}`);
    }

    // A real X server must answer, not merely be started.
    const display = (await guest(computerId, ["xdpyinfo", "-display", ":0"])).split("\n")
      .filter(line => /dimensions|depth of root/.test(line));
    evidence.display = display;
    if (display.length === 0) {
      throw new Error("The X display did not answer xdpyinfo");
    }

    // The port the store allocated, not a fixed 6080: websockify binds the
    // per-computer desktopPort the API will actually hand to the gateway.
    const desktopPort = computer.desktopPort;

    // The browser entrypoint must actually serve the noVNC client.
    const novnc = await guest(computerId, [
      "curl", "--fail", "--silent", "--show-error",
      `http://127.0.0.1:${desktopPort}/vnc.html`
    ]);
    evidence.novncBytes = novnc.length;
    if (!novnc.includes("noVNC")) {
      throw new Error("websockify did not serve the noVNC client");
    }

    // x11vnc must be reachable on the container port the worker will use.
    const ip = (await driver.inspectDetails?.(computerId))?.ipAddresses[0];
    evidence.ip = ip;
    if (!ip) {
      throw new Error("The computer reported no IP address");
    }
    const listening = await guest(computerId, ["ss", "-lnt"]);
    evidence.listening = listening.split("\n")
      .filter(line => /:5900|:6080|:2000\d/.test(line)).map(line => line.trim());
    if (!listening.includes(`0.0.0.0:${desktopPort}`)) {
      throw new Error(`websockify is not bound on the container port: ${listening}`);
    }
    if (!listening.includes("127.0.0.1:5900")) {
      throw new Error(`x11vnc is not loopback-only as required: ${listening}`);
    }

    // Restart is the claim under test: a unit that is not enabled dies here.
    await service.restart(computerId);
    const afterRestart = await guest(computerId, [
      "systemctl", "is-active", "syntrum-xvfb.service", "syntrum-desktop.service",
      "syntrum-vnc.service", "syntrum-novnc.service"
    ]);
    evidence.unitsAfterRestart = afterRestart.split(/\s+/);
    if (evidence.unitsAfterRestart instanceof Array &&
        evidence.unitsAfterRestart.some(s => s !== "active")) {
      throw new Error(`Desktop did not survive restart: ${afterRestart}`);
    }
    const displayAfter = await guest(computerId, ["xdpyinfo", "-display", ":0"]);
    if (!displayAfter.includes("dimensions")) {
      throw new Error("The X display did not come back after restart");
    }
    evidence.survivesRestart = true;

    evidence.status = "PASSED";
  } catch (error) {
    failed = true;
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
    // Capture why before the container (and with it cloud-init's log) is
    // destroyed. Without this a failure costs another full provisioning run.
    if (computerId) {
      evidence.diagnostics = await collectDiagnostics(computerId, guest).catch(
        diagnosticError => ({
          unavailable: diagnosticError instanceof Error
            ? diagnosticError.message : String(diagnosticError)
        })
      );
    }
  } finally {
    // Destroying deletes the only copy of the guest logs, so keep them when
    // asked (SYNTRUM_KEEP_FAILED=1) and only then skip cleanup.
    if (computerId && failed && process.env.SYNTRUM_KEEP_FAILED === "1") {
      evidence.cleanup = {
        container: "kept for inspection",
        destroyWith: `npm run test:live-desktop (or: incus delete ${computerId} --force)`
      };
    } else if (computerId) {
      try {
        const record = service.get(computerId);
        await service.destroy(computerId);
        const gone = await driver.inspect(computerId).catch(error => {
          if (isIncusNotFound(error)) return "deleted";
          throw error;
        });
        evidence.cleanup = { container: gone, storageVolume: record.storageVolume };
        if (gone !== "deleted") {
          evidence.cleanupWarning = `Container still present after destroy: ${gone}`;
        }
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
