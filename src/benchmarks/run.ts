import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BusClient, BusServer } from "../bus/index.js";
import { runBenchmark, type BenchmarkResult } from "./index.js";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloud-ai-os-benchmark-"));
  const server = new BusServer({
    socketPath: join(directory, "benchmark.sock"),
    authorize: () => ({ capabilities: [], sessionIds: [] })
  });
  const clients: BusClient[] = [];
  try {
    await server.listen();
    for (let index = 0; index < 8; index += 1) {
      clients.push(await BusClient.connect({
        socketPath: server.socketPath,
        agent: { id: `benchmark-${index}`, token: "local-benchmark" }
      }));
    }

    const sequential = await runBenchmark({
      name: "uds-ping-sequential",
      warmupIterations: 20,
      iterations: 150,
      operation: async () => {
        const response = await clients[0].ping();
        if (!response.now) {
          throw new Error("Invalid ping response");
        }
        return response;
      }
    });
    const concurrent = await runBenchmark({
      name: "uds-ping-concurrent-8",
      warmupIterations: 32,
      iterations: 400,
      concurrency: 8,
      operation: async context => {
        const response = await clients[context.concurrencySlot].ping();
        if (!response.now) {
          throw new Error("Invalid ping response");
        }
        return response;
      }
    });
    const output: {
      methodology: Record<string, unknown>;
      results: BenchmarkResult[];
      mcpDocumentRead: Record<string, string>;
    } = {
      methodology: {
        transport: "real Unix domain socket and versioned NDJSON protocol",
        setupExcluded: true,
        machine: "local development machine",
        note: "These are local protocol measurements, not application, competitor, or cloud-network benchmarks."
      },
      results: [sequential, concurrent],
      mcpDocumentRead: {
        status: "BLOCKED",
        reason: "A real VS Code installation is required. Run the live VS Code acceptance benchmark on a machine with VS Code; no mock-extension timing is reported as application performance."
      }
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
