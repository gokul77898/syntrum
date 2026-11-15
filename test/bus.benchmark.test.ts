import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { BUS_CAPABILITIES, BusClient, BusServer } from "../src/bus/index.js";

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] as number;
}

function milliseconds(value: number): string {
  return `${value.toFixed(4)}ms`;
}

test("benchmark measures actual Unix socket round-trip latency", async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-bus-benchmark-"));
  const server = new BusServer({
    socketPath: join(temporaryDirectory, "bus.sock"),
    authorize: identity => identity.token === "benchmark-secret"
      ? {
          capabilities: BUS_CAPABILITIES,
          sessionIds: ["benchmark-session"]
        }
      : null
  });
  await server.registerSession("benchmark-session", join(temporaryDirectory, "workspace"), {
    create: true
  });
  await server.listen();

  const clients: BusClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const connect = async (): Promise<BusClient> => {
    const client = await BusClient.connect({
      socketPath: server.socketPath,
      agent: { id: "benchmark-agent", token: "benchmark-secret" },
      requestTimeoutMs: 30000
    });
    clients.push(client);
    return client;
  };

  const latencyClient = await connect();
  for (let index = 0; index < 10; index += 1) {
    await latencyClient.ping();
  }

  const samples: number[] = [];
  const sampleCount = 150;
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await latencyClient.ping();
    samples.push(performance.now() - startedAt);
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const elapsed = samples.reduce((total, sample) => total + sample, 0);
  const mean = elapsed / sampleCount;
  const minimum = sorted[0] as number;
  const maximum = sorted.at(-1) as number;
  const p50 = percentile(sorted, 0.50);
  const p95 = percentile(sorted, 0.95);

  assert.equal(samples.length, sampleCount);
  assert(samples.every(sample => Number.isFinite(sample) && sample >= 0));
  assert(elapsed > 0, "Measured wall-clock latency must be greater than zero");
  t.diagnostic(
    `UDS ping round trips (${sampleCount} real requests): ` +
    `min=${milliseconds(minimum)}, mean=${milliseconds(mean)}, ` +
    `p50=${milliseconds(p50)}, p95=${milliseconds(p95)}, ` +
    `max=${milliseconds(maximum)}, total=${milliseconds(elapsed)}`
  );

  const concurrentClients = await Promise.all(
    Array.from({ length: 16 }, () => connect())
  );
  const requestsPerClient = 25;
  const concurrentStartedAt = performance.now();
  await Promise.all(concurrentClients.map(async client => {
    for (let index = 0; index < requestsPerClient; index += 1) {
      await client.ping();
    }
  }));
  const concurrentElapsed = performance.now() - concurrentStartedAt;
  const concurrentRequests = concurrentClients.length * requestsPerClient;
  assert(concurrentElapsed > 0);
  t.diagnostic(
    `UDS concurrent ping round trips (${concurrentClients.length} clients, ` +
    `${concurrentRequests} real requests): total=${milliseconds(concurrentElapsed)}, ` +
    `mean=${milliseconds(concurrentElapsed / concurrentRequests)}, ` +
    `throughput=${(concurrentRequests / concurrentElapsed * 1000).toFixed(1)} requests/s`
  );
});
