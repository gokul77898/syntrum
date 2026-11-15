import { performance } from "node:perf_hooks";

export type BenchmarkPhase = "warmup" | "measured";

export interface BenchmarkOperationContext {
  phase: BenchmarkPhase;
  iteration: number;
  concurrencySlot: number;
}

export interface BenchmarkOptions<TResult> {
  name: string;
  iterations: number;
  concurrency?: number;
  warmupIterations?: number;
  operation: (
    context: BenchmarkOperationContext
  ) => TResult | Promise<TResult>;
  measureBytes?: (
    result: TResult,
    context: BenchmarkOperationContext
  ) => number;
}

export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ThroughputSummary {
  operationsPerSecond: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}

export interface BenchmarkResult {
  name: string;
  startedAt: string;
  measuredIterations: number;
  warmupIterations: number;
  concurrency: number;
  elapsedMs: number;
  latencyMs: LatencySummary;
  throughput: ThroughputSummary;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
}

function percentile(sortedSamples: readonly number[], quantile: number): number {
  const rank = Math.ceil(quantile * sortedSamples.length);
  return sortedSamples[rank - 1];
}

export function summarizeLatencies(
  samples: readonly number[]
): LatencySummary {
  if (samples.length === 0) {
    throw new RangeError("At least one latency sample is required");
  }

  if (samples.some(sample => !Number.isFinite(sample) || sample < 0)) {
    throw new RangeError("Latency samples must be finite and non-negative");
  }

  const sortedSamples = [...samples].sort((left, right) => left - right);
  const total = sortedSamples.reduce((sum, sample) => sum + sample, 0);

  return {
    count: sortedSamples.length,
    min: sortedSamples[0],
    mean: total / sortedSamples.length,
    p50: percentile(sortedSamples, 0.5),
    p95: percentile(sortedSamples, 0.95),
    p99: percentile(sortedSamples, 0.99),
    max: sortedSamples[sortedSamples.length - 1]
  };
}

function validateOptions<TResult>(options: BenchmarkOptions<TResult>): void {
  if (options.name.trim().length === 0) {
    throw new RangeError("Benchmark name must not be empty");
  }

  if (!Number.isSafeInteger(options.iterations) || options.iterations <= 0) {
    throw new RangeError("iterations must be a positive integer");
  }

  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const warmupIterations = options.warmupIterations ?? 0;
  if (
    !Number.isSafeInteger(warmupIterations) ||
    warmupIterations < 0
  ) {
    throw new RangeError("warmupIterations must be a non-negative integer");
  }
}

async function runPhase<TResult>(
  options: BenchmarkOptions<TResult>,
  phase: BenchmarkPhase,
  iterations: number,
  concurrency: number
): Promise<{ latenciesMs: number[]; totalBytes: number }> {
  const latenciesMs: number[] = [];
  let totalBytes = 0;
  let nextIteration = 0;
  let failed = false;
  let failure: unknown;

  if (iterations === 0) {
    return { latenciesMs, totalBytes };
  }

  const workerCount = Math.min(concurrency, iterations);
  const workers = Array.from(
    { length: workerCount },
    async (_, concurrencySlot) => {
      while (!failed) {
        const iteration = nextIteration;
        if (iteration >= iterations) {
          return;
        }
        nextIteration += 1;

        const context: BenchmarkOperationContext = {
          phase,
          iteration,
          concurrencySlot
        };
        const startedAt = performance.now();

        try {
          const value = await options.operation(context);
          const endedAt = performance.now();

          if (phase === "measured") {
            latenciesMs.push(endedAt - startedAt);

            if (options.measureBytes) {
              const bytes = options.measureBytes(value, context);
              if (!Number.isSafeInteger(bytes) || bytes < 0) {
                throw new RangeError(
                  "measureBytes must return a non-negative safe integer"
                );
              }

              totalBytes += bytes;
              if (!Number.isSafeInteger(totalBytes)) {
                throw new RangeError("Total measured bytes exceeded safe range");
              }
            }
          }
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }
  );

  await Promise.all(workers);

  if (failed) {
    throw new Error(
      `Benchmark "${options.name}" failed during ${phase}; no result emitted`,
      { cause: failure }
    );
  }

  return { latenciesMs, totalBytes };
}

export async function runBenchmark<TResult = unknown>(
  options: BenchmarkOptions<TResult>
): Promise<BenchmarkResult> {
  validateOptions(options);

  const concurrency = options.concurrency ?? 1;
  const warmupIterations = options.warmupIterations ?? 0;

  await runPhase(options, "warmup", warmupIterations, concurrency);

  const startedAt = new Date().toISOString();
  const measurementStartedAt = performance.now();
  const { latenciesMs, totalBytes } = await runPhase(
    options,
    "measured",
    options.iterations,
    concurrency
  );
  const elapsedMs = performance.now() - measurementStartedAt;

  if (!(elapsedMs > 0)) {
    throw new Error(
      `Benchmark "${options.name}" clock did not advance; no result emitted`
    );
  }

  const throughput: ThroughputSummary = {
    operationsPerSecond: options.iterations / (elapsedMs / 1000)
  };

  if (options.measureBytes) {
    throughput.totalBytes = totalBytes;
    throughput.bytesPerSecond = totalBytes / (elapsedMs / 1000);
  }

  return {
    name: options.name,
    startedAt,
    measuredIterations: options.iterations,
    warmupIterations,
    concurrency: Math.min(concurrency, options.iterations),
    elapsedMs,
    latencyMs: summarizeLatencies(latenciesMs),
    throughput,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
}
