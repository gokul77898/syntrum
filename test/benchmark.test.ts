import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runBenchmark,
  summarizeLatencies
} from "../src/benchmarks/index.ts";

test("summarizeLatencies uses nearest-rank percentiles", () => {
  const summary = summarizeLatencies([4, 1, 3, 2]);

  assert.deepEqual(summary, {
    count: 4,
    min: 1,
    mean: 2.5,
    p50: 2,
    p95: 4,
    p99: 4,
    max: 4
  });
  assert.throws(() => summarizeLatencies([]), RangeError);
  assert.throws(() => summarizeLatencies([Number.NaN]), RangeError);
  assert.throws(() => summarizeLatencies([-1]), RangeError);
});

test("runBenchmark separates warmup and measured calls and bounds concurrency", async () => {
  let warmupCalls = 0;
  let measuredCalls = 0;
  let activeMeasuredCalls = 0;
  let maximumActiveCalls = 0;
  const iterations = new Set<number>();
  const slots = new Set<number>();

  const result = await runBenchmark({
    name: "adapter call",
    iterations: 12,
    warmupIterations: 2,
    concurrency: 3,
    operation: async context => {
      if (context.phase === "warmup") {
        warmupCalls += 1;
        return;
      }

      measuredCalls += 1;
      iterations.add(context.iteration);
      slots.add(context.concurrencySlot);
      activeMeasuredCalls += 1;
      maximumActiveCalls = Math.max(
        maximumActiveCalls,
        activeMeasuredCalls
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      activeMeasuredCalls -= 1;
    }
  });

  assert.equal(warmupCalls, 2);
  assert.equal(measuredCalls, 12);
  assert.equal(maximumActiveCalls, 3);
  assert.deepEqual([...iterations].sort((a, b) => a - b), [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
  ]);
  assert.deepEqual([...slots].sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(result.measuredIterations, 12);
  assert.equal(result.warmupIterations, 2);
  assert.equal(result.concurrency, 3);
  assert.equal(result.latencyMs.count, 12);
  assert.ok(result.elapsedMs > 0);
  assert.ok(result.throughput.operationsPerSecond > 0);
  assert.equal("totalBytes" in result.throughput, false);
  assert.equal(result.runtime.nodeVersion, process.version);
  assert.equal(result.runtime.platform, process.platform);
  assert.equal(result.runtime.arch, process.arch);
});

test("runBenchmark derives byte throughput from measured results", async () => {
  const result = await runBenchmark({
    name: "UDS response",
    iterations: 4,
    concurrency: 2,
    operation: context => Buffer.alloc(context.iteration + 1),
    measureBytes: (response, context) => {
      assert.equal(context.phase, "measured");
      return response.byteLength;
    }
  });

  assert.equal(result.throughput.totalBytes, 10);
  assert.equal(
    result.throughput.bytesPerSecond,
    10 / (result.elapsedMs / 1000)
  );
  assert.ok(result.throughput.bytesPerSecond > 0);
});

test("runBenchmark rejects failed operations without a partial result", async () => {
  let calls = 0;

  await assert.rejects(
    runBenchmark({
      name: "failing adapter",
      iterations: 10,
      operation: () => {
        calls += 1;
        if (calls === 3) {
          throw new Error("adapter unavailable");
        }
      }
    }),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed during measured; no result emitted/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "adapter unavailable");
      return true;
    }
  );
  assert.equal(calls, 3);
});

test("runBenchmark validates options and byte counts", async () => {
  await assert.rejects(
    runBenchmark({ name: "invalid", iterations: 0, operation: () => {} }),
    /iterations must be a positive integer/
  );
  await assert.rejects(
    runBenchmark({
      name: "invalid bytes",
      iterations: 1,
      operation: () => new Uint8Array(1),
      measureBytes: () => -1
    }),
    /no result emitted/
  );
});
