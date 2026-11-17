# Cloud computer infrastructure

## Implemented in the repository

The new `src/cloud/` subsystem is a real remote-worker driver, not a macOS process substitute.

- `IncusWorkerDriver` executes lifecycle operations on an Ubuntu worker over SSH.
- SSH uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, no shell invocation, and an optional explicit known-hosts file.
- `CloudComputerService` serializes operations per computer and persists transitions.
- SQLite migration 4 stores computer ID, worker, image, vCPU, RAM, disk, storage volume, desktop port, status, and errors.
- The lifecycle API supports create, list, inspect, start, stop, restart, destroy, and desktop access.
- The API requires a high-entropy operator bearer token. `/health` is public and contains no secrets.
- Cloud-init installs XFCE, x11vnc, websockify, and noVNC, then waits for completion before reporting `running`.
- Browser access is noVNC through an SSH tunnel. No unauthenticated public VNC endpoint is created.
- **Every computer is created with its guest agent bus.** `create()` installs Node and the bus daemon after the container is up, and only reports `running` once `installBus` has proved the unit active, the socket present and the daemon ready. `GET /computers/<id>/agent-access` therefore works on a fresh computer; it returns `409 GUEST_BUS_NOT_PROVISIONED` when a computer has no bus, rather than a socket path nothing is listening on. Set `SYNTRUM_GUEST_RUNTIME=false` to skip the install, or `SYNTRUM_GUEST_NODE_VERSION` to pin a different Node.

The daemon's JavaScript is compiled on the control-plane host and pushed **through the guest**: `incus file push <src>` resolves its source on the *worker*, which the control plane cannot assume it can write to, so the tree is tarred locally and streamed in as base64 chunks. A failed install leaves the computer in `error`, never `running`.

## Resource model

Each computer receives:

- Ubuntu 24.04 through `images:ubuntu/24.04`.
- Explicit `limits.cpu` and `limits.memory`.
- A root-disk size limit.
- A separate Incus storage volume mounted at `/workspace`.
- A worker-loopback proxy port mapped to guest noVNC on port 6080.

The workspace persists across computer stop/start/restart and control-plane restart. Destroying a computer intentionally destroys its workspace volume; this is not a backup or independent long-term storage guarantee.

## Required live-verification infrastructure

No remote worker is configured on the development machine. Live Linux verification is `BLOCKED` until a real host is available.

Minimum test worker:

- Ubuntu 24.04 x86-64 on remote infrastructure.
- SSH key authentication and a known-hosts entry.
- A user permitted to operate Incus (`incus-admin` group or equivalent).
- Incus with a storage pool named `default`.
- Network access to Ubuntu images and package repositories.
- Suggested small acceptance size: 2 vCPU, 4 GiB RAM, 40 GiB disk.

Example worker preparation, to run on that Ubuntu host only after approval:

```sh
sudo apt update
sudo apt install -y incus incus-tools
sudo incus admin init --minimal
incus storage show default
```

The default pool must exist before computer creation. Do not run these commands on the macOS development machine.

## Control plane

```sh
export SYNTRUM_WORKER_SSH_HOST=worker.example.com
export SYNTRUM_WORKER_SSH_USER=syntrum
export SYNTRUM_WORKER_SSH_KNOWN_HOSTS=/Users/gokul/.ssh/known_hosts
export CLOUD_AI_OS_OPERATOR_TOKEN='replace-with-a-random-token-at-least-32-characters'
npm run cloud:dev
```

The API listens on `127.0.0.1:4318`.

### Several workers

`SYNTRUM_WORKERS` takes a comma-separated `user@host` list. Each entry gets its own SSH runner, Incus driver and GPU agent, and each registers in the `workers` table. The first entry is the default a computer is created on; `POST /computers` may name any registered worker with `workerHost`, and an unknown one is a `400` rather than a container that exists only in the control plane's records.

Every lifecycle operation then routes to the computer's **own** worker, including the desktop tunnel and the agent's `agentAccess` socket path. A fork stays on its source's worker, because `incus copy` reads that worker's disk — it cannot branch across hosts. `desktop_port` stays globally unique (not per worker) on purpose: the tunnel maps local port to the same remote port, so uniqueness is what keeps two open tunnels from colliding on the operator's machine.

The first worker is required and fails loudly if unreachable. A later worker that is down is recorded as `unavailable` and does not stop the control plane; its computers fail with the driver's own error. A worker with no GPU at all is normal (an arm64 development box) and is skipped during inventory rather than failing discovery for the others.

```sh
export SYNTRUM_WORKERS=gokul@dev-worker,gokul@gpu.example.com
```

Examples:

```sh
curl -H "Authorization: Bearer $CLOUD_AI_OS_OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"cpu":2,"memoryMb":4096,"diskGb":40}' \
  http://127.0.0.1:4318/computers

curl -H "Authorization: Bearer $CLOUD_AI_OS_OPERATOR_TOKEN" \
  http://127.0.0.1:4318/computers/<id>/start

curl -H "Authorization: Bearer $CLOUD_AI_OS_OPERATOR_TOKEN" \
  http://127.0.0.1:4318/computers/<id>/stop

curl -H "Authorization: Bearer $CLOUD_AI_OS_OPERATOR_TOKEN" \
  http://127.0.0.1:4318/computers/<id>/restart

curl -X DELETE -H "Authorization: Bearer $CLOUD_AI_OS_OPERATOR_TOKEN" \
  http://127.0.0.1:4318/computers/<id>
```

`GET /computers/<id>/access` returns the exact SSH-tunnel command and browser URL. The tunnel is required; the URL is not claimed to work without it.

## Verification status

- `IMPLEMENTED BUT NOT VERIFIED`: real Linux Incus creation, start/stop/restart/destroy, cloud-init desktop boot, persistent workspace, and noVNC browser access. The driver and API exist, but no remote worker is configured.
- `VERIFIED`: non-live command construction, resource/storage configuration, durable lifecycle transitions, operator authorization, and SSH-tunnel access responses. Full suite: **50 passed, 0 failed, 1 skipped**.
- `NOT IMPLEMENTED`: strong microVM isolation, WebRTC, checkpoint/restore, and production orchestration.
- `IMPLEMENTED BUT NOT VERIFIED`: Linux guest packaging of the SYNTRUM MCP runtime. `create()` now installs Node and the bus daemon and verifies the socket, but this has only been exercised on the reference worker by the acceptance harnesses — not by a `POST /computers` against a real worker.

Incus system containers are the initial isolation mechanism, not VM-grade multi-tenancy. Production hostile-user isolation requires a separate microVM or stronger sandbox driver and its own escape tests.

## Next live acceptance gate

1. Configure one real Ubuntu worker.
2. Verify SSH and Incus read-only commands.
3. Create one computer and record provisioning time and actual errors.
4. Start, stop, restart, and inspect it while confirming `/workspace` contents persist.
5. Open the real XFCE desktop through noVNC over the SSH tunnel.
6. Install and run the SYNTRUM MCP runtime in the guest and connect two agents.
7. Only then proceed to GPU discovery/scheduling and checkpoint work.
