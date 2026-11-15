# Verification report — dual-head integration

## Final result

- `IMPLEMENTED + VERIFIED`: persistent dual-head runtime, shared UDS/MCP architecture, document conflicts and durable events, native identity safeguards, HTTP provisioning, non-live integration, and UDS benchmarks.
- `IMPLEMENTED + BLOCKED`: real VS Code GUI acceptance and real application latency. VS Code is not installed on this machine.
- `NOT IMPLEMENTED`: WebRTC/compositor, checkpoint/restore, GPU scheduling/checkpointing, Linux workers, and production cloud orchestration.

## Files inspected and changed

Inspected the complete repository source, native helper, package configuration, tests, extension, and existing docs.

Changed or added:

- Runtime and entrypoint: `src/server.ts`, `src/runtime/*`.
- Shared bus: `src/bus/*`.
- Dual-head composition: `src/integration/index.ts`, `src/integration/dual-head-runtime.ts`.
- Adapter and MCP: `src/adapters/*`, `src/mcp/*`, `adapters/vscode-extension/*`.
- Native lifecycle: `native/app-manager.swift`, rebuilt `.build/app-manager`.
- Evidence tooling: `src/acceptance/live-vscode.ts`, `src/benchmarks/index.ts`, `src/benchmarks/run.ts`.
- Tests: `test/*.test.ts`, `test/helpers/mock-extension.ts`.
- Configuration and documentation: `package.json`, `package-lock.json`, `docs/*`.

No dependency was added beyond the already introduced official `@modelcontextprotocol/sdk`. No user application or existing project data was deleted. Temporary smoke-test data under `/tmp` was removed.

## Commands executed and final results

### Static and native checks

```sh
npm run typecheck
npm run check:extension
npm run build:native
.build/app-manager inspect 2147483647 com.apple.TextEdit
```

Result: TypeScript passed, extension JavaScript syntax passed, Swift build passed, and the real helper returned a structured nonexistent-process response.

```sh
.build/app-manager frontmost
```

Result: returned the actual frontmost application PID, bundle identity, launch date, and activation policy without activating another app.

### Complete non-live suite

```sh
npm test
```

Final result: **48 tests discovered; 47 passed, 0 failed, 1 skipped**. The skipped test is the external live VS Code adapter test. Duration was approximately 5.95 seconds.

The integrated tests spawn actual MCP stdio client/server processes and use real SQLite and Unix sockets. Test doubles are limited to native application responses and the VS Code extension API; they are labeled unit/non-live tests and are not presented as real GUI verification.

Verified in the integrated harness:

- Two distinct agents share one adapter.
- Concurrent writes produce one winner and one `VERSION_CONFLICT`.
- Agent identity and cross-session/capability checks are enforced.
- Document events persist with monotonic SQLite cursors.
- Runtime close/restart preserves the session, agent grant, workspace, adapter socket, and bridge token.
- The extension reconnects and MCP reads/writes continue after restart.
- HTTP session/agent provisioning and typed VS Code launch configuration work without arbitrary shell or argument input.
- Sole pre-existing and same-bundle reused processes cannot be terminated through stale session records.
- SQLite and bus socket modes are `0600`.

### Actual server-entrypoint smoke test

```sh
CLOUD_AI_OS_DATA_ROOT=/tmp/syntrum-smoke.tuovH6 node --import tsx src/server.ts
```

Executed against `127.0.0.1:4317`:

1. `GET /health` returned healthy with zero sessions.
2. `POST /sessions` returned 201.
3. `POST /sessions/<id>/agents` returned 201.
4. `GET /sessions/<id>/dual-head` reported the adapter started and no extension connected.
5. The temporary supervisor was killed and restarted with the same data root.
6. `GET /sessions/<id>` returned 200 with the same session.
7. A real `BusClient` authenticated with the original agent token and successfully called `adapter.workspace.list` after stale-socket recovery.
8. The temporary supervisor was stopped and its `/tmp` data was removed.

### Benchmark

```sh
npm run benchmark
```

Real UDS results on macOS ARM64 with Node `v26.13.0`:

- Sequential: 20 warmups, 150 measured calls, mean 0.0222 ms, p95 0.0281 ms, 44,682.8 requests/s.
- Eight clients: 32 warmups, 400 measured calls, mean 0.1262 ms, p95 0.2023 ms, 62,976.0 requests/s.

See `docs/benchmarking.md` for methodology and limitations.

### Live acceptance

```sh
npm run test:live-vscode
```

Result: exit code 2 with `status: BLOCKED`: `Visual Studio Code is not installed at /Applications/Visual Studio Code.app`.

The live harness is implemented but not verified. It does not substitute mock GUI output or emit a real VS Code latency result.

## Remaining failures

No non-live test, typecheck, extension syntax, native build, smoke-test, or benchmark failures remain in the final runs. The only incomplete acceptance gate is the explicitly blocked real VS Code GUI path.

During development, incomplete launch-date helpers caused five runtime failures and one new integration assertion initially overlooked a valid `document.opened` event. Those issues were corrected and the final results above are from subsequent complete runs.

## Remaining security concerns

- Loopback HTTP has no operator authentication; it is a trusted-local interface only.
- Bridge tokens are retained in mode-`0600` SQLite for reconnection; agent tokens are hashed.
- Workspace checks do not eliminate every hostile external symlink-swap race.
- macOS apps and permission contexts are shared with the login session; this is not tenant isolation.
- Agent writes are unsaved VS Code buffer edits. VS Code crash recovery and unsaved-buffer restoration are not implemented.
- Events not yet delivered by the extension to the runtime are not durable.

## Next engineering milestone

Install VS Code and execute the live acceptance harness. Resolve real workspace-trust, Accessibility, focus, extension-host, and reconnect behavior before marking the human/agent GUI milestone verified. Do not start the streaming/GPU/checkpoint tracks in parallel with that evidence gate.


## Antigravity manual live acceptance — latest

The older VS Code blocker above is historical. The current target is Google Antigravity IDE.

```sh
npm run test:live-antigravity-manual
```

Result: exit code 0 with `status: VERIFIED`. The real Antigravity extension handshake and document API passed, a human manually edited/saved the document, two real MCP agents completed conflict/retry behavior, real extension events arrived, focus remained unchanged, and supervisor restart/reconnection passed. Full criterion evidence is in `docs/antigravity-acceptance.md`.

A subsequent `npm test` run again produced **47 passed, 0 failed, 1 skipped**, and `npm run check:extension` passed.

Fully automated GUI input, unsaved-buffer crash recovery, disconnected-event durability, and local HTTP operator authentication are not marked verified by this result.


## Remote cloud-worker foundation — latest

Added `src/cloud/` with an SSH/Incus worker driver, durable computer lifecycle service, resource and persistent-volume provisioning, XFCE/noVNC cloud-init, and an authenticated control-plane API on port 4318.

`npm test` now reports **51 discovered, 50 passed, 0 failed, 1 skipped**. The three new cloud tests cover exact Incus commands, durable lifecycle/access behavior, and HTTP operator authorization.

No real Linux worker is configured: `SYNTRUM_WORKER_SSH_HOST`, `SYNTRUM_WORKER_SSH_USER`, `SYNTRUM_WORKER_SSH_KNOWN_HOSTS`, and `CLOUD_AI_OS_OPERATOR_TOKEN` are absent. Therefore real Linux provisioning, desktop streaming, and guest MCP execution are `IMPLEMENTED BUT NOT VERIFIED`, not operational claims. See `docs/cloud-infrastructure.md` for required infrastructure and the live acceptance gate.


## Shared GPU scheduler and worker execution — latest

Added `src/gpu/` with NVIDIA discovery, persistent inventory/allocation/metrics, conservative shared-memory scheduling, Incus GPU attachment, fixed CUDA `cudaMalloc`/`cudaMemset` execution, MPS thread quotas, release, and recovery. MIG discovery is present, but dynamic MIG allocation is explicitly rejected. Time-slicing, MPS, MIG, and dedicated modes are documented as different isolation models.

`npm test` now reports **54 discovered, 53 passed, 0 failed, 1 skipped**. The three GPU tests cover shared allocation on one physical GPU, capacity rejection, release, recovery, and command construction. `npm run typecheck` passes.

No NVIDIA worker is configured. Real GPU utilization, concurrent guest CUDA execution, capacity enforcement, release on hardware, and worker/scheduler restart recovery remain `IMPLEMENTED BUT NOT VERIFIED`. Hardware and acceptance requirements are in `docs/gpu-infrastructure.md`. No cloud-computer or GPU-sharing claim is being made from unit tests.
