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
- `NOT IMPLEMENTED`: Linux guest packaging of the SYNTRUM MCP runtime, strong microVM isolation, WebRTC, shared GPU scheduling, checkpoint/restore, and production orchestration.

Incus system containers are the initial isolation mechanism, not VM-grade multi-tenancy. Production hostile-user isolation requires a separate microVM or stronger sandbox driver and its own escape tests.

## Next live acceptance gate

1. Configure one real Ubuntu worker.
2. Verify SSH and Incus read-only commands.
3. Create one computer and record provisioning time and actual errors.
4. Start, stop, restart, and inspect it while confirming `/workspace` contents persist.
5. Open the real XFCE desktop through noVNC over the SSH tunnel.
6. Install and run the SYNTRUM MCP runtime in the guest and connect two agents.
7. Only then proceed to GPU discovery/scheduling and checkpoint work.
