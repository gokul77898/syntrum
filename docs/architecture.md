# SYNTRUM architecture: macOS dual-head prototype

## Implemented runtime

`src/server.ts` binds the supervisor HTTP API to `127.0.0.1:4317`. `DualHeadRuntime` in `src/integration/dual-head-runtime.ts` is the composition root for four real components:

1. `RuntimeSupervisor` persists sessions, application identity, resources, agent grants, and events in SQLite through versioned migrations.
2. `BusServer` accepts versioned NDJSON frames over a Unix domain socket and authorizes each agent/session/capability.
3. One `VSCodeAdapter` per session owns the authenticated extension-host socket. MCP processes do not create competing adapter listeners.
4. Separate MCP stdio processes use `BusApplicationAdapter` to call the shared adapter through UDS. Document list/read/write and event operations have independent capabilities.

Session workspaces are created under `data/sessions/<session-id>/workspace`. Resource records retain the canonical workspace, adapter socket, and bridge token so the extension can reconnect after a supervisor restart. Agent tokens are stored as SHA-256 hashes; bridge tokens are stored locally so they can be reused. Database and socket permissions are restricted to the current user.

## Dual-head document path

The document path is:

`MCP client -> MCP stdio server -> BusClient -> BusServer -> session VSCodeAdapter -> VSCode extension -> TextDocument/WorkspaceEdit`

Only the extension adapter writes VS Code-backed documents. Agents do not receive direct workspace-write capability for those files, so the numeric `TextDocument.version` is the single optimistic-concurrency authority for this path. A stale write returns `VERSION_CONFLICT` and the current snapshot instead of overwriting the human edit.

Adapter events received by the runtime are written to SQLite as `adapter.document.*` events and published to authorized bus subscribers. MCP event reads use durable SQLite IDs, not volatile extension-buffer IDs. Live subscriptions must be recreated after restart; they are not described as durable queues.

`WorkspaceEdit` changes the real VS Code buffer without deliberately showing a document or activating the application. It does not automatically save the buffer to disk. Real GUI/no-focus verification requires the live acceptance path described below.

## Process identity and launch safety

`native/app-manager.swift` uses AppKit, not shell commands. It reports PID, bundle identity, launch date, process-reuse indicators, and frontmost-application identity. Launch accepts a bounded typed JSON configuration for internal callers. HTTP does not accept arbitrary arguments, environment variables, or shell commands.

The supervisor persists launch dates and checks them alongside PID and bundle ID. It refuses session termination for shared, pre-existing, unknown-origin, mismatched, or unverified processes. Inspection and termination are serialized per application, and shutdown waits for native operations.

VS Code launch uses dedicated user-data and extensions directories, an extension-development path, the session workspace, and `activates: false`. If AppKit reports a reused/pre-existing process rather than a newly launched isolated instance, the dual-head launch is rejected.

## Verification boundary

The non-live suite uses real SQLite, real UDS, real MCP stdio processes, and unit-test doubles only for native application responses or the VS Code extension API. Those tests verify protocol integration, conflicts, authorization, persistence, and reconnection; they do not prove a real GUI interaction.

`src/acceptance/manual-antigravity.ts` is the live Antigravity gate. It launches an isolated real Antigravity instance, connects two MCP agents, and waits for a human to edit and save a real document in that GUI. The run verified the human edit, actual extension events, one-winner concurrent writes, losing-agent retry, unchanged frontmost application, and supervisor restart/reconnection. See `docs/antigravity-acceptance.md`. Fully automated GUI input is a separate unverified investigation and is not used as acceptance evidence.

## Production boundary

This remains a trusted-local macOS prototype, not a cloud OS or multi-tenant isolation boundary. Production Linux workers still require authenticated remote control, per-session containers or VMs, resource policies, scoped volumes, and a real display/input stack.

WebRTC capture/streaming, multi-window composition, CRIU, GPU checkpointing, Metal/NVIDIA scheduling, Linux workers, billing, and cloud orchestration are not implemented. No competitor superiority or sub-1.5-second restoration claim follows from this prototype.
