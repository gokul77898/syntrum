import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudComputerService } from "../src/cloud/service.js";
import { CloudComputerStore } from "../src/cloud/store.js";
import type { ComputerSpec, WorkerDriver } from "../src/cloud/types.js";
import {
  GpuScheduler,
  GpuStore,
  NvidiaWorkerAgent,
  type GpuAllocation,
  type GpuDevice,
  type GpuMetric,
  type GpuWorkerAgent
} from "../src/gpu/index.js";

class TestComputerDriver implements WorkerDriver {
  async create(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(): Promise<void> {}
  async destroy(): Promise<void> {}
  async inspect(): Promise<"running"> {
    return "running";
  }
}

class TestGpuAgent implements GpuWorkerAgent {
  readonly executions: string[] = [];
  readonly releases: string[] = [];
  constructor(private readonly delayMs = 0) {}

  async discover(): Promise<GpuDevice[]> {
    return [{
      workerHost: "syntrum@worker.example",
      uuid: "GPU-test-0",
      index: 0,
      model: "Test GPU",
      totalMemoryMb: 1000,
      usedMemoryMb: 100,
      utilizationPercent: 5,
      temperatureC: 40,
      migCapable: false
    }];
  }

  async execute(allocation: GpuAllocation): Promise<void> {
    this.executions.push(allocation.id);
    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
  }

  async release(allocation: GpuAllocation): Promise<void> {
    this.releases.push(allocation.id);
  }

  async measure(gpuUuid: string): Promise<GpuMetric> {
    return {
      gpuUuid,
      utilizationPercent: 75,
      usedMemoryMb: 500,
      temperatureC: 55,
      recordedAt: new Date().toISOString()
    };
  }
}

function harness(t: test.TestContext, delayMs = 0) {
  const directory = mkdtempSync(join(tmpdir(), "syntrum-gpu-test-"));
  const databasePath = join(directory, "cloud.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const computerStore = new CloudComputerStore(databasePath);
  const computers = new CloudComputerService({
    store: computerStore,
    driver: new TestComputerDriver(),
    workerHost: "syntrum@worker.example"
  });
  const agent = new TestGpuAgent(delayMs);
  const gpuStore = new GpuStore(databasePath);
  return {
    computers,
    computerStore,
    agent,
    gpuStore,
    scheduler: new GpuScheduler(
      gpuStore,
      computerStore,
      new Map([["syntrum@worker.example", agent]])
    )
  };
}

test("scheduler shares one physical GPU, rejects excess capacity, and releases allocations", async t => {
  const { computers, scheduler, agent, gpuStore } = harness(t, 25);
  t.after(() => {
    scheduler.close();
    computers.close();
  });
  const first = await computers.create();
  const second = await computers.create();
  const allocationA = await scheduler.allocate({
    computerId: first.id,
    memoryMb: 400,
    durationSec: 1
  });
  const allocationB = await scheduler.allocate({
    computerId: second.id,
    memoryMb: 400,
    durationSec: 1
  });
  await assert.rejects(
    scheduler.allocate({ computerId: first.id, memoryMb: 200, durationSec: 1 }),
    (error: unknown) => {
      assert.equal((error as any).code, "GPU_CAPACITY_EXHAUSTED");
      return true;
    }
  );
  await scheduler.idle();
  assert.deepEqual(agent.executions.sort(), [allocationA.id, allocationB.id].sort());
  assert.deepEqual(agent.releases.sort(), [allocationA.id, allocationB.id].sort());
  for (const id of [allocationA.id, allocationB.id]) {
    const allocation = gpuStore.getAllocation(id);
    assert.equal(allocation.status, "succeeded");
    assert.ok(allocation.releasedAt);
    assert.ok(gpuStore.listMetrics(id).length >= 1);
  }
  assert.equal(scheduler.listAllocations(true).length, 0);
});

test("scheduler recovery releases device ownership and records uncertain outcomes", async t => {
  const { computers, scheduler, agent, gpuStore } = harness(t);
  t.after(() => {
    scheduler.close();
    computers.close();
  });
  const computer = await computers.create();
  const now = new Date().toISOString();
  const allocation: GpuAllocation = {
    id: "recovery-allocation",
    computerId: computer.id,
    workerHost: computer.workerHost,
    gpuUuid: "GPU-test-0",
    memoryMb: 100,
    computePercent: 50,
    mode: "time-slice",
    workload: "cuda-memset",
    durationSec: 1,
    status: "running",
    createdAt: now,
    updatedAt: now
  };
  gpuStore.insertAllocation(allocation);
  await scheduler.recover();
  assert.deepEqual(agent.releases, [allocation.id]);
  const recovered = gpuStore.getAllocation(allocation.id);
  assert.equal(recovered.status, "error");
  assert.match(recovered.error ?? "", /uncertain/);
  assert.ok(recovered.releasedAt);
});

test("NVIDIA agent parses real nvidia-smi output and constructs guest CUDA execution", async () => {
  const commands: string[][] = [];
  const agent = new NvidiaWorkerAgent(async args => {
    commands.push([...args]);
    if (args.includes("--query-gpu=mig.mode.current")) {
      return "Disabled";
    }
    if (args[0] === "nvidia-smi" && args[1].startsWith("--query-gpu=")) {
      return "GPU-real-0, 0, NVIDIA T4, 16384, 1024, 7, 41";
    }
    return "";
  });
  const devices = await agent.discover();
  assert.equal(devices[0].model, "NVIDIA T4");
  assert.equal(devices[0].totalMemoryMb, 16384);
  assert.equal(devices[0].migCapable, true);
  const allocation: GpuAllocation = {
    id: "allocation-command",
    computerId: "computer-command",
    workerHost: "syntrum@worker.example",
    gpuUuid: "GPU-real-0",
    memoryMb: 256,
    computePercent: 40,
    mode: "mps",
    workload: "cuda-memset",
    durationSec: 1,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await agent.execute(allocation);
  await agent.release(allocation);
  assert.ok(commands.some(args => args[0] === "nvidia-cuda-mps-control"));
  assert.ok(commands.some(args => args.includes("gpu") && args.includes("id=0")));
  // Not "the first exec": a CUDA preflight runs before the workload now, so
  // select the exec that actually carries the memset source.
  const execution = commands.find(args =>
    args[1] === "exec" && args.some(value => value.includes("cudaMemset"))
  )!;
  assert.ok(execution, "the CUDA workload must run");
  assert.ok(execution.includes("CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=40"));
  assert.ok(execution.includes("python3"));
  assert.ok(execution.includes("cudaMemset") === false);
  assert.ok(execution.some(value => value.includes("cudaMemset")));
});
