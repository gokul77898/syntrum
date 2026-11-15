# Implementation status and next milestones

Statuses distinguish code existence from execution evidence. See `docs/verification.md` for commands and results.

## Dual-head milestone

- `IMPLEMENTED + VERIFIED`: migrated SQLite sessions/resources/grants/events; real server restart smoke test.
- `IMPLEMENTED + VERIFIED`: AppKit identity inspection and frontmost reporting on the current native build; process safety unit/integration tests.
- `IMPLEMENTED + VERIFIED`: UDS framing, session/capability authorization, workspace operations, concurrent agents, conflict handling, and event isolation.
- `IMPLEMENTED + VERIFIED`: reusable adapter contract, shared bus-backed MCP stdio agents, durable document events, runtime restart and extension-credential reconnection in the integrated non-live harness.
- `IMPLEMENTED + VERIFIED`: full non-live test command, native build, TypeScript and extension syntax checks, and real UDS benchmarks.
- `IMPLEMENTED + VERIFIED`: real Antigravity manual-GUI/human/MCP acceptance, actual events, concurrent conflict/retry, no focus change, and supervisor restart/reconnection (`docs/antigravity-acceptance.md`).
- `IMPLEMENTED BUT NOT VERIFIED`: fully automated GUI input, unsaved-buffer recovery after IDE restart/crash, and disconnected-event durability.
- `NOT IMPLEMENTED`: local HTTP operator authentication.

## Next milestone: reliability and local API hardening

1. Measure graceful IDE restart/crash behavior for unsaved buffers without promising recovery.
2. Test disconnected extension events through supervisor restart and report loss/duplication behavior.
3. Require a high-entropy bearer token for local `/sessions/*` operator routes while retaining agent-scoped UDS authorization.
4. Record real Antigravity MCP latency measurements.
5. Keep automated GUI input as a separate investigation; do not use it to invalidate the verified manual acceptance.

## Later layers: not implemented

- Layer 1: capture, unified composition, WebRTC, browser playback, and remote input.
- Layer 2: application snapshots, CRIU investigation, process/GPU checkpointing, and restoration measurements.
- Layer 4: Metal metrics, NVIDIA provider, MPS/MIG/HAMi integrations, quotas, and real GPU workloads.
- Production: authenticated remote control, Linux worker isolation/orchestration, persistent cloud storage, accounting, and multi-user deployment.

Each later capability needs its own evidence gate. macOS dual-head results are not evidence of Linux, NVIDIA, CRIU, WebRTC, or production-cloud functionality.
