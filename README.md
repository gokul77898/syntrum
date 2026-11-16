# SYNTRUM

**A multiplayer AI agent cloud OS runtime.** A browser-accessible cloud computer where a human (through a GUI) and multiple AI agents (through MCP) share the *same* real guest OS, applications, files and workspace.

Not a mock. Not a screenshot stream. A real Linux container with a real X server, a real window manager, and a real filesystem — that both a person and a fleet of agents can drive at the same time.

---

## The problem this solves

Today's agent tooling gives you two bad options:

1. **Agents in a terminal.** Fast, but no GUI, no window state, no visual context. The human can't see what the agent sees.
2. **Agents driving a browser via screenshots.** The agent and the human are looking at *different* machines, and neither owns the real OS.

SYNTRUM's position: the human and the agents must share **one** OS session. One filesystem. One set of running applications. The human clicks in a window; the agent edits the document in that same window; both see the result.

That's the "dual-head" idea — one machine, two kinds of head.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (human)                     MCP clients (agents)   │
│  noVNC / WebSocket                   stdio MCP servers      │
└───────────┬─────────────────────────────────┬───────────────┘
            │                                 │
            │  authenticated desktop gateway  │  capability-scoped
            │  (planned — see Roadmap)        │  agent tokens
            ▼                                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Control plane  (src/cloud/*)                               │
│  CloudComputerService · REST API · SQLite lifecycle store   │
│  IncusWorkerDriver — creates/starts/stops/destroys guests   │
└───────────┬─────────────────────────────────────────────────┘
            │  SSH (BatchMode, no shell, bounded argv)
            ▼
┌─────────────────────────────────────────────────────────────┐
│  Worker host  (Linux, running Incus)                        │
│  restricted per-user Incus project                          │
└───────────┬─────────────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloud computer  (Incus system container)                   │
│  XFCE desktop · Xvfb :0 · x11vnc · websockify/noVNC         │
│  /workspace  ← dedicated persistent storage volume          │
└─────────────────────────────────────────────────────────────┘
```

### The dual-head document path

For the *application-level* dual-head (Phase 4 in the plan), the concurrency authority is the editor's own document version:

```
MCP client → MCP stdio server → BusClient → BusServer
           → session VSCodeAdapter → VS Code extension → TextDocument / WorkspaceEdit
```

Only the extension adapter writes editor-backed documents. Agents do **not** get direct filesystem write access to those files, so the numeric `TextDocument.version` is the single source of truth for optimistic concurrency. A stale write returns `VERSION_CONFLICT` plus the current snapshot instead of clobbering the human's edit.

Agent events are persisted to SQLite as `adapter.document.*` and published to authorized subscribers. MCP event reads use durable SQLite IDs, not volatile editor buffer IDs.

---

## Repository layout

| Path | What it is |
|---|---|
| `src/cloud/` | Control plane: lifecycle service, Incus driver, SSH runner, REST server, loopback browser UI |
| `src/runtime/` | `RuntimeSupervisor`, SQLite migrations, process identity, native manager contract |
| `src/bus/` | Versioned NDJSON bus over a Unix domain socket, with per-agent capability authorization |
| `src/adapters/` | The `VSCodeAdapter` — the only component that writes editor-backed documents |
| `src/integration/` | `DualHeadRuntime` — the composition root wiring supervisor + bus + adapter + MCP |
| `src/mcp/` | MCP stdio servers and the bus-backed application adapter |
| `src/gpu/` | NVIDIA worker agent, scheduler and store (no GPU on the reference machine) |
| `src/acceptance/` | Live, opt-in acceptance harnesses that touch real infrastructure |
| `src/benchmarks/` | Latency benchmarks |
| `adapters/vscode-extension/` | The VS Code extension: handshake gating, event queueing, document RPC |
| `native/` | macOS helpers (`app-manager.swift`, `gui-input.swift`) — AppKit process identity |
| `web/` | The browser UI assets |
| `docs/` | Architecture, infrastructure runbook, audit, benchmarking, verification |
| `test/` | The full non-live suite (61 tests) |

---

## Quick start

**Requirements:** Node.js ≥ 26, npm. A Linux worker host with Incus only if you want real cloud computers.

```bash
npm install
npm run typecheck
npm test
```

Run the local control plane and browser UI:

```bash
npm run cloud:dev     # REST API on 127.0.0.1
npm run ui            # loopback browser control panel
```

Run the macOS dual-head runtime (editor + agents on the local machine):

```bash
npm run build:native  # swiftc → .build/app-manager, .build/gui-input
npm run dev           # supervisor API on 127.0.0.1:4317
npm run mcp:stdio     # an MCP agent process
```

### Scripts

| Script | Purpose |
|---|---|
| `npm test` | Full non-live suite. **The gate.** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | Dual-head supervisor (`127.0.0.1:4317`) |
| `npm run cloud:dev` | Cloud control plane |
| `npm run ui` | Loopback browser UI |
| `npm run mcp:stdio` | MCP stdio agent server |
| `npm run benchmark` | Latency benchmark |
| `npm run build:native` | Compile the Swift AppKit helpers |
| `npm run check:extension` | Syntax-check the VS Code extension |
| `npm run test:live-incus` | **Live.** Real container lifecycle on a real worker. |
| `npm run test:live-vscode` | **Live.** Real editor acceptance. |
| `npm run test:live-antigravity` | **Live.** Real Antigravity acceptance. |
| `npm run test:live-adapter` | **Live.** Extension host, opt in via `CLOUD_AI_OS_LIVE_VSCODE_TEST=1` |
| `npm run test:live-gpu` | **Live.** Real GPU allocation: installs the guest CUDA runtime, attaches a GPU, runs one workload. Needs an NVIDIA worker. |

Scripts marked **Live** mutate real infrastructure and are opt-in. They are never part of `npm test`.

---

## Configuration

The control plane reads SSH and worker settings from the environment. **No hostnames, IP addresses, or credentials are committed to this repository.**

| Variable | Meaning |
|---|---|
| `SYNTRUM_WORKER_SSH_HOST` | Worker host (single-worker setup, and the default worker) |
| `SYNTRUM_WORKER_SSH_USER` | SSH user on the worker |
| `SYNTRUM_WORKERS` | Optional comma-separated `user@host` list to drive **several** workers. The first entry is the default a computer is created on, and `POST /computers` may name any registered worker with `workerHost`. Falls back to the pair above. |
| `SYNTRUM_WORKER_SSH_KNOWN_HOSTS` | Path to a `known_hosts` file (host key verification is enforced) |
| `SYNTRUM_WORKER_SSH_IDENTITY_FILE` | Path to an SSH private key |
| `CLOUD_AI_OS_OPERATOR_TOKEN` | Operator bearer token, **≥ 32 characters**. Required to start the cloud API. |

The operator token file is `.syntrum-operator-token` (gitignored). Generate one with:

```bash
head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 43
```

---

## Security model

This is a **trusted-local single-operator prototype**. Read this section before exposing anything.

### What is enforced

- **SSH is argv-only.** Every worker command goes through `createSshCommandRunner`: explicit `execFile`, no shell interpolation, `BatchMode=yes`, strict host-key checking, a `-n` stdin redirect, and a bounded timeout. There is no path from an HTTP request to an arbitrary shell string.
- **The browser cannot execute commands.** `src/cloud/browser-ui.ts` proxies an explicit allowlist — `/api/computers[...]`, `/api/workers`, `/api/gpus`, `/api/gpu/*`. **`/exec` is deliberately not proxied.** The browser is a state and lifecycle surface only.
- **No fabricated state.** `/api/computers/:id/desktop` returns `{available: false, gateway: "not_implemented"}` rather than faking a screen. Metrics come from real Incus inspection. There are no invented agents, sessions or connection statuses anywhere in the UI.
- **Agent capability scoping.** Every bus frame is authorized per agent, session and capability. Agents do not hold a blanket token.
- **Document versioning.** Stale writes fail loudly with `VERSION_CONFLICT` instead of silently overwriting.
- **Secrets.** Agent tokens are stored as SHA-256 hashes. The database and socket files are mode `0600`/`0700`.

### What is *not* enforced — stated plainly

- **The HTTP listener is loopback-only with a single operator bearer token.** That token grants full privilege, including `/exec`. Anyone who can read the token can run commands in guests. This is operator-level trust, not multi-tenant isolation.
- **A cloud computer is one Linux container.** A user who reaches the GUI has ordinary OS rights inside it, including sudo as configured. MCP scoping constrains *agents via the bus*; it is not a sandbox around every process in the guest.
- **No filesystem sandbox boundary.** Workspace path validation and symlink checks are real, but Node path validation cannot eliminate symlink-swap races against a hostile concurrent process. Production needs `openat`-style directory-handle confinement.
- **The bridge token must be retained in plaintext** so the editor extension can reconnect after a restart. Hashed tokens cannot be replayed to a client.
- **No atomic fence between a human GUI edit and an in-flight `applyEdit`.** The version check happens immediately before the write, but there is no lock spanning the await. Concurrency is only *proven* when no agent write is in flight. Treat simultaneous human+agent edits on the same document as unsupported until this is closed.
- **Not implemented:** session stop / resource reclamation, unsaved-buffer recovery after an editor crash, durable event delivery for events still inside the editor at crash time, and re-establishing live bus subscriptions after a restart (they must be recreated).
- **`size=` on Incus volumes is decorative** on a `dir` storage pool without `prjquota`. Disk limits are not enforced by the driver.

`docs/audit.md` tracks these as first-class open findings. It is kept honest on purpose.

---

## Verifying it's real

The claim "real cloud computer, not mock HTML" is testable. A capture of a guest desktop is a read of the X server's framebuffer out of guest RAM — a mock page has no framebuffer to read:

```bash
# Captured INSIDE the guest, over the control plane
incus exec <id> -- import -window root /tmp/shot.png
```

The discriminator is the kernel and process namespace:

| | Host (Mac) | Guest (cloud computer) |
|---|---|---|
| Kernel | `Darwin 27.2.0` | `Linux 7.0.0-43-generic` |
| Arch | `arm64` | `aarch64` |
| Process namespace | host | `incus info` → `Type: container` |

Write a file to the guest from outside the GUI and it appears in the GUI's file manager. That round trip cannot be faked by a web page.

---

## Testing philosophy

`npm test` is the gate: 61 tests, 60 pass, 1 intentional skip (a live editor test that requires opt-in), 0 fail.

Three rules the suite follows:

1. **Never mock success in a live test.** Live acceptance harnesses either do the real thing or fail loudly.
2. **Tests must not touch infrastructure.** No test in `npm test` launches containers or mutates user data.
3. **Assert persisted state, not command invocation.** Failure-path tests check the *final stored status* after an error, not merely that a command rejected.

---

## Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 — macOS dual-head | ✅ Proven | Real editor + real MCP agents on a shared workspace, with live acceptance |
| 2 — Cloud computer lifecycle | ✅ Working | Container create/start/stop/destroy via Incus, with regression guards |
| 3 — Desktop provisioning | ⚠️ Partial | XFCE/Xvfb/x11vnc/noVNC proven by hand; `desktopCloudInit()` has not yet been run end-to-end |
| 4 — Guest dual-head | ⬜ Not started | Human GUI + MCP agents inside the *guest*, sharing `/workspace` |
| 5 — Browser UI | ⚠️ Partial | Loopback control panel exists; desktop panel honestly reports `not_implemented` |
| 6 — Authenticated desktop gateway | ⬜ Not started | HTTPS + WebSocket gateway to the guest desktop, session-scoped |

### Known gaps

- **The provisioned desktop is unproven.** The working desktop was assembled manually. `desktopCloudInit()` in `src/cloud/incus-driver.ts` writes the right systemd units but has never completed a full run, so the desktop does not survive a container restart yet.
- **No desktop gateway.** Reaching the desktop currently requires a hand-opened SSH tunnel. Phase 6 replaces this.
- **Guest MCP runtime does not exist.** Agents currently drive the *host's* editor, not the guest's.
- **`diskGb` is not enforced** (see the storage note above).
- **A worker with a skewed clock** breaks `apt` and TLS. Not a SYNTRUM bug, but it will bite you.
- **GPU paths are unexercised on real hardware.** The GPU modules are written against an NVIDIA worker agent and `npm run test:live-gpu` is the gate, but no NVIDIA box has been rented yet, so live CUDA remains `IMPLEMENTED BUT NOT VERIFIED`. `nvidia.runtime` is not a live-updatable Incus option, so the **first** GPU allocation on a computer restarts it to mount the host driver libraries; later allocations do not.

---

## Design principles

- **No second backend.** Reuse the existing runtime; never add a parallel framework.
- **No fabricated state, ever.** If something isn't ready, the API says so. `not_implemented` is a valid, honest answer.
- **Honest documentation.** Unproven claims are labelled unproven, including in this README. See `docs/audit.md`.
- **Bounded argv over shell strings.** Every privileged operation takes a typed argument list.
- **Smallest complete change.** Fewer moving parts, fewer places for the truth to hide.

---

## License

ISC
