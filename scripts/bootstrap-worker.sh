#!/usr/bin/env bash
#
# SYNTRUM worker bootstrap for a fresh Ubuntu 24.04 box.
#
# Written for a rented GPU server, where every minute of manual setup is a
# minute of paid rental. Idempotent: safe to re-run after a partial failure.
#
# Prerequisites, on purpose: the NVIDIA *driver* must already be installed and
# `nvidia-smi` working. Driver installation is vendor- and instance-specific
# (DKMS vs prebuilt, secure boot, kernel version) and guessing at it is how a
# rented box ends up unusable. This script installs the container *toolkit*
# that lets containers use that driver.
#
# Usage:
#   SYNTRUM_CONTROL_PLANE=https://cloud.example:4318 \
#   SYNTRUM_OPERATOR_TOKEN=... \
#   sudo -E ./scripts/bootstrap-worker.sh
#
# Everything is configurable by environment variable; nothing secret is
# written into this file.

set -euo pipefail

SYNTRUM_USER="${SYNTRUM_USER:-syntrum}"
SYNTRUM_STORAGE_POOL="${SYNTRUM_STORAGE_POOL:-default}"
SYNTRUM_CONTROL_PLANE="${SYNTRUM_CONTROL_PLANE:-}"
SYNTRUM_OPERATOR_TOKEN="${SYNTRUM_OPERATOR_TOKEN:-}"
# Where the operator's public key comes from. Set to "none" to skip and add
# keys yourself.
SYNTRUM_AUTHORIZED_KEYS="${SYNTRUM_AUTHORIZED_KEYS:-none}"
# Install the NVIDIA container toolkit. Turn off for a CPU-only worker.
SYNTRUM_GPU="${SYNTRUM_GPU:-auto}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo -E)."
[ -r /etc/os-release ] || die "Cannot read /etc/os-release."
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Expected Ubuntu, found '${ID:-unknown}'. Continuing."
[ "${VERSION_ID:-}" = "24.04" ] || warn "Expected 24.04, found '${VERSION_ID:-unknown}'. Continuing."

log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release jq openssh-server

# ── Incus ────────────────────────────────────────────────────────────────────
# The Zabbly repository is the upstream-maintained source; Ubuntu's own archive
# ships an older Incus than the 6.x this project targets.
log "Incus from the Zabbly repository"
if ! command -v incus >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://pkgs.zabbly.com/key.asc \
    | gpg --dearmor -o /etc/apt/keyrings/zabbly.gpg
  chmod 0644 /etc/apt/keyrings/zabbly.gpg
  cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: $(. /etc/os-release && echo "${VERSION_CODENAME}")
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.gpg
EOF
  apt-get update -qq
  apt-get install -y -qq incus
else
  log "Incus already installed; skipping repository setup"
fi

log "Initialising Incus (storage pool '${SYNTRUM_STORAGE_POOL}')"
if incus storage show "${SYNTRUM_STORAGE_POOL}" >/dev/null 2>&1; then
  log "Storage pool already exists; skipping init"
else
  # --auto picks a sane pool and bridge. On a rented GPU box the root disk is
  # usually the only large filesystem, so the dir driver is the honest default:
  # it needs no spare block device, which ZFS and LVM both do.
  incus admin init --auto
fi

# ── GPU userspace ────────────────────────────────────────────────────────────
gpu_present() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; }

if [ "${SYNTRUM_GPU}" = "auto" ]; then
  if gpu_present; then SYNTRUM_GPU=yes; else SYNTRUM_GPU=no; fi
fi

if [ "${SYNTRUM_GPU}" = "yes" ]; then
  log "NVIDIA container toolkit"
  if ! gpu_present; then
    # Not fatal: a GPU instance whose driver is missing can still host CPU
    # computers, and failing here would waste the rental while someone works
    # out why the driver is absent.
    warn "nvidia-smi is not working. Incus cannot expose a GPU to a container without it."
    warn "Install the NVIDIA driver for this instance, then re-run this script with SYNTRUM_GPU=yes."
  else
    nvidia-smi -L
    if ! dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
      curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list
      apt-get update -qq
      # apt never fails on an empty repository; it just finds no package and
      # the install below fails with a confusing "has no installation
      # candidate". Name the real cause here instead.
      if ! apt-cache policy nvidia-container-toolkit 2>/dev/null | grep -q 'Candidate: [0-9]'; then
        warn "The NVIDIA repository lists no nvidia-container-toolkit for $(dpkg --print-architecture)."
        warn "Check /etc/apt/sources.list.d/nvidia-container-toolkit.list and 'apt-get update' output."
      fi
      apt-get install -y -qq nvidia-container-toolkit
    else
      log "nvidia-container-toolkit already installed; skipping"
    fi
    # Incus uses libnvidia-container to bind the driver into a container that
    # sets nvidia.runtime=true.
    ldconfig
    log "GPU check: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"

    # libcudart is a *guest* userspace library, not a host one: the host only
    # supplies the driver. SYNTRUM installs it per guest (GuestProvisioner.
    # installCudaRuntime), and it comes from multiverse — which a minimal cloud
    # image does not always enable, and apt then reports the unhelpful "has no
    # installation candidate". Flag it here, while the box is cheap to fix.
    if ! apt-cache policy libcudart12 2>/dev/null | grep -q 'Candidate: [0-9]'; then
      warn "This host's apt has no candidate for libcudart12, so guests created here will"
      warn "fail their CUDA preflight. It lives in the multiverse component; check that"
      warn "/etc/apt/sources.list.d/ enables it (grep -r multiverse /etc/apt/sources.list*)."
    fi
  fi
else
  log "Skipping GPU setup (SYNTRUM_GPU=${SYNTRUM_GPU})"
fi

# ── Operator account ─────────────────────────────────────────────────────────
log "Operator account '${SYNTRUM_USER}'"
if id "${SYNTRUM_USER}" >/dev/null 2>&1; then
  log "User already exists"
else
  # Belongs to the incus-admin group, not a sudoer: on a single-tenant worker
  # this account only needs to drive Incus.
  useradd --create-home --shell /bin/bash "${SYNTRUM_USER}"
fi
# The snap and deb installs place an admin socket/socket in the incus-admin
# group; a user in that group can drive Incus without root.
incus_group="incus-admin"
if getent group "${incus_group}" >/dev/null 2>&1; then
  usermod -aG "${incus_group}" "${SYNTRUM_USER}"
else
  warn "Group '${incus_group}' not found; Incus may not permit the operator to connect."
fi
install -d -m 0700 -o "${SYNTRUM_USER}" -g "${SYNTRUM_USER}" "/home/${SYNTRUM_USER}/.ssh"

if [ "${SYNTRUM_AUTHORIZED_KEYS}" != "none" ]; then
  if [ -f "${SYNTRUM_AUTHORIZED_KEYS}" ]; then
    install -m 0600 -o "${SYNTRUM_USER}" -g "${SYNTRUM_USER}" \
      "${SYNTRUM_AUTHORIZED_KEYS}" "/home/${SYNTRUM_USER}/.ssh/authorized_keys"
    log "Installed authorized_keys from ${SYNTRUM_AUTHORIZED_KEYS}"
  else
    warn "SYNTRUM_AUTHORIZED_KEYS='${SYNTRUM_AUTHORIZED_KEYS}' is not a readable file; skipped."
  fi
else
  log "No authorized_keys provided (SYNTRUM_AUTHORIZED_KEYS=none)"
fi

log "SSH server"
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 || warn "Could not start SSH."

# ── Verification: the same three checks the control plane performs ───────────
log "Verifying the worker is usable"
fail=0
incus version >/dev/null 2>&1 || { warn "incus version failed"; fail=1; }
incus storage show "${SYNTRUM_STORAGE_POOL}" >/dev/null 2>&1 || { warn "storage pool '${SYNTRUM_STORAGE_POOL}' is not usable"; fail=1; }
sudo -u "${SYNTRUM_USER}" -H incus info >/dev/null 2>&1 \
  || { warn "operator '${SYNTRUM_USER}' cannot reach Incus (check group membership; a re-login may be needed)"; fail=1; }

if [ "${SYNTRUM_GPU}" = "yes" ]; then
  incus config set "" nvidia.runtime=true 2>&1 | grep -qi "unrecognized\|unknown" \
    && warn "This Incus does not recognise nvidia.runtime; GPU passthrough will not work."
fi

echo
incus version | sed 's/^/    /'
echo "    arch: $(uname -m)"
echo "    disk: $(df -h / | awk 'NR==2 {print $4" free ("$5" used)"}')"
if [ "${fail}" -ne 0 ]; then
  warn "One or more checks failed. Fix them before provisioning."
fi

# ── Register with the control plane ──────────────────────────────────────────
if [ -n "${SYNTRUM_CONTROL_PLANE}" ] && [ -n "${SYNTRUM_OPERATOR_TOKEN}" ]; then
  log "Registering with ${SYNTRUM_CONTROL_PLANE}"
  # A worker registers by being reachable and healthy; the control plane records
  # it when it next checks health. This call is informational and must not fail
  # the bootstrap. Note this is only a reachability check: the control plane
  # still has to be told about this host, by adding it to SYNTRUM_WORKERS (or as
  # the single SYNTRUM_WORKER_SSH_HOST). Nothing here registers the worker's SSH
  # destination on its behalf.
  if curl -fsS --max-time 15 \
      -H "authorization: Bearer ${SYNTRUM_OPERATOR_TOKEN}" \
      "${SYNTRUM_CONTROL_PLANE%/}/health" >/dev/null; then
    log "Control plane responded healthy"
  else
    warn "Could not reach the control plane. Check the URL, the token, and any firewall."
  fi
else
  log "No control plane URL/token given; skipping registration"
fi

log "Done"
cat <<EOF

Next:
  1. Point the control plane at this box:
       SYNTRUM_WORKER_SSH_HOST=<this host>  SYNTRUM_WORKER_SSH_USER=${SYNTRUM_USER}  npm run cloud:dev
     For more than one worker, list them instead (first entry is the default):
       SYNTRUM_WORKERS=${SYNTRUM_USER}@<this host>,<user>@<other host>  npm run cloud:dev
  2. Provision without a desktop first (faster, and proves the worker):
       curl -X POST -H "authorization: Bearer \$TOKEN" -H 'content-type: application/json' \\
         -d '{"cpu":2,"memoryMb":4096,"diskGb":20,"desktopEnabled":false}' \\
         ${SYNTRUM_CONTROL_PLANE:-http://127.0.0.1:4318}/computers
  3. Only then add the desktop, and last the GPU allocation.
EOF
