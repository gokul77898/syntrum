import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
  WorkerStore,
  checkWorkerHealth,
  createCloudHttpServer,
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
  const driver = new IncusWorkerDriver(run);
  const dataRoot = await mkdtemp(join("/tmp", "syntrum-incus-live-"));
  const databasePath = join(dataRoot, "cloud.sqlite");
  const operatorToken = randomBytes(32).toString("base64url");
  const evidence: Record<string, unknown> = {
    status: "IMPLEMENTED", workerHost, gpu: "UNAVAILABLE_NO_NVIDIA_HARDWARE"
  };
  let service: CloudComputerService | undefined;
  let workers: WorkerStore | undefined;
  let server: ReturnType<typeof createCloudHttpServer> | undefined;
  let computerId: string | undefined;
  let cleanupComplete = false;

  const stopHttp = async () => {
    if (server) {
      server.close();
      await once(server, "close");
      server = undefined;
    }
    service?.close();
    service = undefined;
    workers?.close();
    workers = undefined;
  };
  const startHttp = async () => {
    service = new CloudComputerService({
      store: new CloudComputerStore(databasePath), driver,
      workerHost, desktopEnabled: false
    });
    workers = new WorkerStore(databasePath);
    const registration = await checkWorkerHealth(run, host, user);
    workers.register(registration);
    evidence.workerRegistration = registration;
    server = createCloudHttpServer({ service, workerStore: workers, operatorToken });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return `http://localhost:${port}`;
  };
  const request = async (base: string, path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base.replace("localhost", "127.0.0.1")}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${operatorToken}`, "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
    return { status: response.status, body: await response.json() as any };
  };
  const execute = (base: string, args: string[], timeoutMs?: number) =>
    request(base, `/computers/${computerId}/exec`, {
      method: "POST", body: JSON.stringify({ args, timeoutMs })
    });
  let base = "";
  try {
    base = await startHttp();
    const workersResponse = await request(base, "/workers");
    if (workersResponse.status !== 200 || workersResponse.body.workers.length !== 1) {
      throw new Error("Worker registration API failed");
    }
    const expectedArchitecture = workersResponse.body.workers[0].architecture;
    const created = await request(base, "/computers", {
      method: "POST",
      body: JSON.stringify({ cpu: 1, memoryMb: 1024, diskGb: 5, desktopEnabled: false })
    });
    if (created.status !== 201) {
      const possibleId = created.body?.computerId;
      if (typeof possibleId !== "string") {
        throw new Error(`Creation error omitted resource recovery ID: ${JSON.stringify(created)}`);
      }
      computerId = possibleId;
      throw new Error(`Container creation failed: ${JSON.stringify(created)}`);
    }
    computerId = created.body.computer.id;
    evidence.create = created.body.computer;

    const uname = await execute(base, ["uname", "-m"]);
    const osRelease = await execute(base, ["cat", "/etc/os-release"]);
    if (uname.status !== 200 || uname.body.output.trim() !== expectedArchitecture) {
      throw new Error(`Guest architecture mismatch: ${JSON.stringify(uname)}, expected=${expectedArchitecture}`);
    }
    evidence.commandExecution = { uname: uname.body.output, osRelease: osRelease.body.output };

    const write = await execute(base, [
      "sh", "-c", "printf 'persistent workspace verified\\n' > /workspace/syntrum-persistence.txt"
    ]);
    if (write.status !== 200) throw new Error(`Workspace write failed: ${JSON.stringify(write)}`);
    for (const [operation, status] of [
      ["stop", "stopped"], ["start", "running"], ["restart", "running"]
    ] as const) {
      const result = await request(base, `/computers/${computerId}/${operation}`, { method: "POST" });
      if (result.status !== 200 || result.body.computer.status !== status) {
        throw new Error(`${operation} failed: ${JSON.stringify(result)}`);
      }
    }
    evidence.lifecycle = { stop: true, start: true, restart: true };
    const persisted = await execute(base, ["cat", "/workspace/syntrum-persistence.txt"]);
    if (persisted.status !== 200 || !persisted.body.output.includes("persistent workspace verified")) {
      throw new Error(`Workspace persistence failed: ${JSON.stringify(persisted)}`);
    }
    evidence.persistentWorkspace = persisted.body.output;
    const details = await request(base, `/computers/${computerId}/details`);
    if (details.status !== 200 || details.body.details.ipAddresses.length === 0) {
      throw new Error(`Resource discovery failed: ${JSON.stringify(details)}`);
    }
    evidence.resourceDiscovery = details.body.details;

    let timeoutRejected = false;
    try {
      await service!.execute(computerId!, ["sh", "-c", "sleep 0.2"], 50);
    } catch {
      timeoutRejected = true;
    }
    if (!timeoutRejected) throw new Error("Execution timeout was not enforced");
    const invalid = await execute(base, ["command-that-does-not-exist"]);
    if (invalid.status < 500) throw new Error("Nonexistent guest command was not rejected");
    evidence.timeoutAndErrors = { timeoutRejected, nonexistentCommandRejected: true };

    await stopHttp();
    base = await startHttp();
    const recovered = await request(base, "/computers");
    if (recovered.status !== 200 || !recovered.body.computers.some((item: any) => item.id === computerId)) {
      throw new Error("Control-plane restart did not recover computer");
    }
    const recoveredRead = await execute(base, ["cat", "/workspace/syntrum-persistence.txt"]);
    if (recoveredRead.status !== 200 || !recoveredRead.body.output.includes("persistent workspace verified")) {
      throw new Error("Workspace read after recovery failed");
    }
    evidence.controlPlaneRecovery = { recovered: true, workspaceRead: true };

    const destroyed = await request(base, `/computers/${computerId}`, { method: "DELETE" });
    if (destroyed.status !== 200 || destroyed.body.computer.status !== "deleted") {
      throw new Error(`Delete failed: ${JSON.stringify(destroyed)}`);
    }
    if (await driver.inspect(computerId!) !== "deleted") {
      throw new Error("Container still exists after deletion");
    }
    try {
      await run(["incus", "storage", "volume", "show", "default", `syntrum-workspace-${computerId}`]);
      throw new Error("Workspace volume still exists after deletion");
    } catch (error) {
      if (error instanceof Error ? error.message.includes("still exists after deletion") : !isIncusNotFound(error)) {
        throw error;
      }
    }
    evidence.destroy = { containerDeleted: true, volumeDeleted: true };
    evidence.status = "VERIFIED";
    const deletedId = computerId;
    computerId = undefined;
    await stopHttp();
    await rm(dataRoot, { recursive: true, force: true });
    cleanupComplete = true;
    evidence.deletedComputerId = deletedId;
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.computerId = computerId;
    evidence.dataRoot = dataRoot;
    console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } finally {
    if (!cleanupComplete) {
      const cleanupErrors: string[] = [];
      if (computerId && service) {
        try { await service.destroy(computerId); }
        catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
      }
      try { await stopHttp(); } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      if (cleanupErrors.length > 0) console.error("Cleanup errors:", cleanupErrors);
      console.error(`Acceptance data retained at ${dataRoot}`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
