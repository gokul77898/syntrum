# Current audit and remaining risks

## Corrected findings

- The in-memory session `Map` was replaced with migrated SQLite records and restart reconciliation.
- Stable application IDs and persisted AppKit launch dates supplement legacy PID routes. Same-bundle PID reuse is covered by tests.
- Shared, pre-existing, unknown-origin, and mismatched applications cannot be terminated through a session.
- Per-session workspaces, UDS agent identities, explicit capabilities, versioned document writes, and durable event reads are implemented.
- Multiple MCP stdio agents now share one runtime-owned adapter rather than competing for the extension listener.
- Extension handshake gating, reconnect queuing, event-origin attribution, cursor pagination, and stale-socket ownership checks are implemented and unit-tested.
- The standard `npm test` command now runs the complete non-live suite rather than only adapter tests.

## Remaining security and reliability concerns

### Trusted local operator API

The HTTP listener is loopback-only but has no operator authentication. Any local process that can reach it can create sessions, provision agent credentials, and request application actions. This is acceptable only for the current trusted-local prototype. Remote or multi-user exposure is blocked until operator authentication and authorization are added.

### Local secrets

Agent tokens are hashed, but the VS Code bridge token must be retained for extension reconnection and is therefore stored in SQLite. The database is mode `0600` and newly created data directories use mode `0700`; this is not a hardware-backed secret store or protection from the same OS user.

### Filesystem boundary

Workspace traversal and symlink checks are real, but Node path validation cannot completely remove symlink-swap races when a hostile external process modifies workspace directories concurrently. Production needs stronger directory-handle/openat-style confinement and an actual sandbox boundary.

### Application and document lifetime

macOS applications belong to the login session, not to a supervisor session. This prototype does not create strong per-session WindowServer, clipboard, keychain, TCC, or filesystem isolation.

Agent writes modify the VS Code buffer and are not automatically saved. Supervisor restart with VS Code kept alive is tested; VS Code crash recovery and restoration of unsaved buffers are not implemented. Session stop/resource reclamation is also not implemented.

### Event delivery

SQLite stores events after the runtime adapter receives them. The extension queues frames during a socket disconnect, but events still inside VS Code during an application crash are not durable. Live bus subscriptions must be re-established after restart.

### Lifecycle crash windows

Tests cover in-flight shutdown and restart reconciliation. A machine/process crash after AppKit launches an application but before its registration is committed can still require operator inspection; this is not claimed to be a fully transactional launch protocol.

## Live verification and remaining gaps

The manual Antigravity acceptance passed all ten requested criteria with real MCP agents, a real human GUI edit, actual extension events, conflict/retry behavior, unchanged focus, and supervisor restart/reconnection (`docs/antigravity-acceptance.md`). Fully automated GUI input, IDE crash recovery, disconnected-event durability, and local HTTP operator authentication remain separate unverified or unimplemented concerns.
