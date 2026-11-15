# Benchmark methodology and current measurements

## Commands

```sh
npm run benchmark
npm run test:live-vscode
```

`npm run benchmark` uses `src/benchmarks/run.ts` and the reusable `runBenchmark` harness. It measures real Unix-domain-socket ping requests through the versioned NDJSON protocol, with setup and connection establishment excluded. It does not use a fake transport.

`npm run test:live-vscode` measures real MCP `document_read` calls only after the live VS Code acceptance flow succeeds. Mock-extension timings are never reported as VS Code application performance.

## Measured on this machine

Environment: macOS ARM64, Node `v26.13.0`; run timestamp `2026-11-10T15:13:31Z` (UTC).

| Workload | Warmup | Measured calls | Concurrency | Mean latency | p95 latency | Throughput |
|---|---:|---:|---:|---:|---:|---:|
| UDS ping, sequential | 20 | 150 | 1 | 0.0222 ms | 0.0281 ms | 44,682.8 requests/s |
| UDS ping, concurrent | 32 | 400 | 8 | 0.1262 ms | 0.2023 ms | 62,976.0 requests/s |

The sequential minimum was 0.0168 ms and maximum was 0.1786 ms. The concurrent minimum was 0.0867 ms and maximum was 0.3030 ms. Complete raw results are printed as JSON by the command.

These are closed-loop local protocol measurements, not application latency, cloud-network latency, streaming latency, checkpoint time, or a competitor comparison. Different runs and machines will produce different values. The harness rejects the entire run on operation failure rather than emitting a success-only result.

## Blocked measurement

Real VS Code MCP `document_read` latency is `BLOCKED` because VS Code is not installed on this machine. No value is reported for that workload.
