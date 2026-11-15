import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CloudComputerService,
  CloudComputerStore,
  IncusWorkerDriver,
  createCloudHttpServer,
  type ComputerSpec,
  type WorkerDriver
} from "../src/cloud/index.js";

class FakeWorkerDriver implements WorkerDriver {
  readonly calls: string[] = [];
  async create(spec: ComputerSpec): Promise<void> {
    this.calls.push(`create:${spec.id}`);
  }
  async start(id: string): Promise<void> {
    this.calls.push(`start:${id}`);
  }
  async stop(id: string): Promise<void> {
    this.calls.push(`stop:${id}`);
  }
  async restart(id: string): Promise<void> {
    this.calls.push(`restart:${id}`);
  }
  async destroy(spec: Pick<ComputerSpec, "id" | "storageVolume">): Promise<void> {
    this.calls.push(`destroy:${spec.id}`);
  }
  async inspect(): Promise<"running"> {
    return "running";
  }
}

function memoryService(driver = new FakeWorkerDriver()) {
  const store = new CloudComputerStore(":memory:");
  return {
    driver,
    store,
    service: new CloudComputerService({
      store,
      driver,
      workerHost: "syntrum@worker.example"
    })
  };
}

test("Incus driver issues real resource, storage, desktop, and lifecycle commands", async () => {
  const commands: readonly string[][] = [];
  const driver = new IncusWorkerDriver(async (args) => {
    (commands as string[][]).push([...args]);
    return args[1] === "list" ? '[{"status":"Running"}]' : "";
  });
  const spec: ComputerSpec = {
    id: "computer-1",
    workerHost: "syntrum@worker.example",
    image: "images:ubuntu/24.04",
    cpu: 4,
    memoryMb: 8192,
    diskGb: 80,
    storageVolume: "workspace-1",
    desktopPort: 20001
  };
  await driver.create(spec);
  assert.deepEqual(commands[0], ["incus", "create", "images:ubuntu/24.04", "computer-1"]);
  assert.ok(commands.some(args => args.includes("limits.cpu=4")));
  assert.ok(commands.some(args => args.includes("limits.memory=8192MiB")));
  assert.ok(commands.some(args => args.includes("size=80GiB")));
  assert.ok(commands.some(args => args.includes("source=workspace-1")));
  assert.ok(commands.some(args => args.includes("listen=tcp:127.0.0.1:20001")));
  assert.ok(commands.some(args => args.includes("cloud-init.user-data")));
  assert.deepEqual(await driver.inspect(spec.id), "running");
  await driver.stop(spec.id);
  await driver.restart(spec.id);
  await driver.destroy(spec);
  assert.ok(commands.some(args => args[1] === "stop"));
  assert.ok(commands.some(args => args[1] === "restart"));
  assert.ok(commands.some(args => args[1] === "delete"));
});

test("cloud computer lifecycle persists and access remains SSH-tunneled", async t => {
  const directory = await mkdtemp(join(tmpdir(), "syntrum-cloud-test-"));
  const databasePath = join(directory, "cloud.sqlite");
  const driver = new FakeWorkerDriver();
  let store = new CloudComputerStore(databasePath);
  let service = new CloudComputerService({
    store,
    driver,
    workerHost: "syntrum@worker.example"
  });
  t.after(async () => {
    service.close();
    await rm(directory, { recursive: true, force: true });
  });

  const created = await service.create({ cpu: 2, memoryMb: 2048, diskGb: 20 });
  assert.equal(created.status, "running");
  assert.equal(created.desktopPort, 20000);
  assert.equal((await service.stop(created.id)).status, "stopped");
  assert.equal((await service.start(created.id)).status, "running");
  assert.equal((await service.restart(created.id)).status, "running");
  const access = service.access(created.id);
  assert.equal(access.publicExposure, false);
  assert.match(access.sshTunnelCommand, /20000:127.0.0.1:20000/);
  assert.match(access.browserUrlAfterTunnel, /vnc.html/);

  service.close();
  store = new CloudComputerStore(databasePath);
  service = new CloudComputerService({
    store,
    driver,
    workerHost: "syntrum@worker.example"
  });
  assert.equal(service.get(created.id).status, "running");
  assert.equal((await service.destroy(created.id)).status, "deleted");
  assert.equal(service.list().length, 0);
});

test("cloud HTTP API requires operator auth and provisions computers", async t => {
  const { service } = memoryService();
  const server = createCloudHttpServer({
    service,
    operatorToken: "test-operator-token-with-at-least-32-characters"
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    service.close();
  });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const denied = await fetch(`${base}/computers`);
  assert.equal(denied.status, 401);
  const headers = { authorization: "Bearer test-operator-token-with-at-least-32-characters" };
  const createdResponse = await fetch(`${base}/computers`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cpu: 1, memoryMb: 1024, diskGb: 10 })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json() as any).computer;
  const accessResponse = await fetch(`${base}/computers/${created.id}/access`, { headers });
  assert.equal(accessResponse.status, 200);
  const access = await accessResponse.json() as any;
  assert.equal(access.protocol, "noVNC over SSH tunnel");
  const destroyed = await fetch(`${base}/computers/${created.id}`, {
    method: "DELETE",
    headers
  });
  assert.equal(destroyed.status, 200);
});
