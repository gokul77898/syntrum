import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { errorMessage } from "../runtime/errors.js";

const runFile = promisify(execFile);

// Phase 4 groundwork: the guest runtime needs Node >= 26 (it uses node:sqlite,
// absent from the Ubuntu 24.04 nodejs package at 18.19), so the guest must
// install its own Node from the upstream dist.
//
// Never `curl | bash` and never trust the download: the tarball is verified
// against the publisher's own SHASUMS256.txt before it is extracted.
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const DIST_BASE = "https://nodejs.org/dist";

// Node names its Linux artifacts by kernel architecture, not uname's spelling
// on every platform. Only entries confirmed to have a linux build are listed.
const PLATFORM_BY_MACHINE: Record<string, string> = {
  x86_64: "linux-x64",
  amd64: "linux-x64",
  aarch64: "linux-arm64",
  arm64: "linux-arm64"
};

// Shared libraries Node's Linux builds link against that a minimal image does
// not ship. libatomic.so.1 is the arm64 blocker observed live: without it node
// exists on disk but cannot exec ("error while loading shared libraries").
// x86_64 links no separate libatomic, so it is requested only for arm64 —
// asking for it unconditionally would fail the install if a future image drops
// the package from an x86_64 archive.
const NODE_RUNTIME_PACKAGES: Record<string, readonly string[]> = {
  "linux-arm64": ["libatomic1", "ca-certificates"],
  "linux-x64": ["ca-certificates"]
};

export function nodeRuntimePackages(platform: string): readonly string[] {
  const packages = NODE_RUNTIME_PACKAGES[platform];
  if (!packages) {
    throw new Error(`No runtime packages known for platform: ${platform}`);
  }
  return packages;
}

export type GuestExecutor = (
  id: string,
  args: readonly string[],
  timeoutMs?: number
) => Promise<string>;

export function resolveNodePlatform(machine: string): string {
  const platform = PLATFORM_BY_MACHINE[machine.trim()];
  if (!platform) {
    throw new Error(`Unsupported guest architecture for Node: ${machine.trim() || "(empty)"}`);
  }
  return platform;
}

/** Single-quotes for a remote shell; embedded quotes are closed and reopened. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Pure so the verification step is testable without a guest. Every value is
// validated or derived, never interpolated from caller input unexamined.
export function nodeInstallScript(
  version: string,
  platform: string,
  aptDateCheckDisabled = false
): string {
  if (!NODE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid Node version: ${version}`);
  }
  if (!Object.values(PLATFORM_BY_MACHINE).includes(platform)) {
    throw new Error(`Invalid Node platform: ${platform}`);
  }
  const archive = `node-${version}-${platform}.tar.xz`;
  const installRoot = "/usr/local/lib/nodejs";
  const extracted = `${installRoot}/${archive.replace(/\.tar\.xz$/, "")}`;
  const aptOptions = aptDateCheckDisabled ? " -o Acquire::Check-Date=false" : "";
  const packages = nodeRuntimePackages(platform).join(" ");
  return `set -eu
if [ "$(id -u)" -ne 0 ]; then echo "guest provisioning must run as root" >&2; exit 1; fi
command -v curl >/dev/null 2>&1 || { echo "curl is required in the guest" >&2; exit 1; }
command -v xz >/dev/null 2>&1 || { echo "xz-utils is required in the guest" >&2; exit 1; }
# Node's Linux binaries are not fully static: the arm64 build needs the GCC
# atomic runtime, which a minimal image does not ship. Installing the toolchain
# without this leaves a node that cannot exec at all.
if command -v apt-get >/dev/null 2>&1; then
  apt-get${aptOptions} update -qq
  DEBIAN_FRONTEND=noninteractive apt-get${aptOptions} install -y -qq ${packages}
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSL ${DIST_BASE}/${version}/${archive} -o ${archive}
curl -fsSL ${DIST_BASE}/${version}/SHASUMS256.txt -o SHASUMS256.txt
# Verify against the publisher's checksum for this artifact alone; a bare
# sha256sum -c over the whole file would fail on the other platforms' lines.
grep ' ${archive}$' SHASUMS256.txt > expected.txt
[ -s expected.txt ] || { echo "no checksum published for ${archive}" >&2; exit 1; }
sha256sum -c expected.txt
mkdir -p ${installRoot}
tar -xJf ${archive} -C ${installRoot}
for tool in node npm npx; do
  ln -sf ${extracted}/bin/$tool /usr/local/bin/$tool
done
# Last line, and the only one that proves the toolchain actually executes:
# a missing shared library fails here rather than silently installing a node
# that cannot run.
/usr/local/bin/node --version
`;
}

export type GuestNodeInstallResult = {
  version: string;
  platform: string;
};

/**
 * The guest bus daemon and the modules it imports. The bus uses only Node
 * builtins, so this list is the entire dependency closure — no npm install and
 * no network access inside the guest.
 *
 * Kept explicit rather than globbed: a new import that reaches outside these
 * directories would otherwise ship a daemon that cannot start.
 */
export const GUEST_BUS_MODULES = [
  "guest/bus-daemon",
  "guest/relay",
  "bus/server",
  "bus/client",
  "bus/errors",
  "bus/protocol",
  "bus/types",
  "bus/workspace",
  "bus/index",
  "adapters/errors",
  "adapters/types",
  "adapters/index"
] as const;

export const GUEST_BUS_UNIT = `[Unit]
Description=SYNTRUM guest agent bus
After=local-fs.target

[Service]
Type=simple
# A dedicated runtime directory so the socket is not in a world-writable /tmp.
RuntimeDirectory=syntrum
RuntimeDirectoryMode=0750
Environment=SYNTRUM_BUS_SOCKET=/run/syntrum/bus.sock
Environment=SYNTRUM_WORKSPACE_ROOT=/workspace
EnvironmentFile=-/etc/syntrum/agents.env
ExecStart=/usr/local/bin/node /opt/syntrum/guest/bus-daemon.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;

export type GuestBusInstallResult = {
  modules: number;
  unitPath: string;
  socketPath: string;
};

export class GuestProvisioner {
  // aptDateCheckDisabled is opt-in and exists only for hosts whose clock is
  // ahead of the repositories; it relaxes the date check, never signatures.
  constructor(
    private readonly execute: GuestExecutor,
    private readonly aptDateCheckDisabled = false
  ) {}

  // Reads the guest's own architecture rather than assuming the worker's, so a
  // mismatched download fails loudly instead of installing a binary that
  // cannot execute.
  async nodePlatform(id: string): Promise<string> {
    const machine = await this.execute(id, ["uname", "-m"], 30_000);
    return resolveNodePlatform(machine);
  }

  async installNode(id: string, version: string): Promise<GuestNodeInstallResult> {
    const platform = await this.nodePlatform(id);
    // Installing a toolchain is a download plus an unpack; the default SSH
    // timeout is far too short for either.
    const reported = await this.execute(
      id,
      ["sh", "-c", nodeInstallScript(version, platform, this.aptDateCheckDisabled)],
      15 * 60_000
    );
    const installed = reported.trim().split("\n").at(-1)?.trim() ?? "";
    if (installed !== version) {
      throw new Error(
        `Guest Node install reported ${installed || "(no output)"}, expected ${version}`
      );
    }
    return { version, platform };
  }

  // Proves the installed Node can actually do what the runtime needs: import
  // node:sqlite, which is the specific reason Node 18 is insufficient.
  async verifyNodeSqlite(id: string): Promise<void> {
    try {
      await this.execute(id, [
        "node", "-e",
        "const {DatabaseSync}=require('node:sqlite');" +
        "const d=new DatabaseSync(':memory:');d.exec('select 1');"
      ], 60_000);
    } catch (error) {
      throw new Error(
        `Guest Node cannot use node:sqlite: ${errorMessage(error, "command failed")}`
      );
    }
  }

  /**
   * Installs and starts the agent bus inside the guest.
   *
   * The daemon is compiled on the host and copied in: the guest has no
   * toolchain and no npm access, and Node's own type-stripping cannot run the
   * bus, which uses constructor parameter properties. Compiling here means the
   * guest runs plain JavaScript with no dependencies at all.
   *
   * `upload` performs the actual byte transfer; the caller supplies it so this
   * module does not have to know whether the transport is scp, a pipe over ssh,
   * or a test double. It must place the *contents* of `localDirectory` directly
   * in `remoteDirectory` — not a subdirectory named after the source, which is
   * what a naive recursive copy of `<dir>/.` produces.
   */
  async installBus(
    id: string,
    options: {
      compiledDirectory: string;
      agents: readonly { id: string; token: string }[];
      upload: (id: string, localDirectory: string, remoteDirectory: string) => Promise<void>;
    }
  ): Promise<GuestBusInstallResult> {
    // Node must exist before the unit can run; failing here names the real
    // prerequisite rather than surfacing as a unit that restarts forever.
    try {
      await this.execute(id, ["/usr/local/bin/node", "--version"], 30_000);
    } catch {
      throw new Error("Guest Node is not installed; run installNode before installBus");
    }
    if (options.agents.length === 0) {
      throw new Error("At least one agent grant is required to start the bus");
    }
    for (const agent of options.agents) {
      // The values land in an EnvironmentFile, so a newline would inject a
      // second variable and a space would split the entry.
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(agent.id)) {
        throw new Error(`Invalid agent id: ${agent.id}`);
      }
      if (!/^[A-Za-z0-9._-]{16,}$/.test(agent.token)) {
        throw new Error(`Invalid agent token for '${agent.id}'`);
      }
    }

    await this.execute(id, ["mkdir", "-p", "/opt/syntrum", "/etc/syntrum"], 30_000);
    await options.upload(id, options.compiledDirectory, "/opt/syntrum");

    // The unit names this exact path. A recursive copy that nests the source
    // directory leaves the files one level down, and the only symptom is a
    // restart loop with "Cannot find module" in the journal.
    const daemon = await this.execute(id, [
      "sh", "-c",
      "test -f /opt/syntrum/guest/bus-daemon.js && echo present || echo missing"
    ], 30_000);
    if (daemon.trim() !== "present") {
      const listing = await this.execute(id, [
        "sh", "-c", "find /opt/syntrum -maxdepth 2 -name 'bus-daemon.js' 2>/dev/null | head -3"
      ], 30_000).catch(() => "");
      throw new Error(
        "/opt/syntrum/guest/bus-daemon.js is missing after upload; the transfer " +
        `must place the compiled contents directly in /opt/syntrum` +
        (listing.trim() ? ` (found: ${listing.trim().split("\n").join(", ")})` : "")
      );
    }

    const envFile = `SYNTRUM_GUEST_AGENTS=${options.agents.map(a => `${a.id}:${a.token}`).join(",")}`;
    await this.execute(id, [
      "sh", "-c",
      // 0600: the file holds agent tokens, and the unit reads it as root.
      `printf '%s\\n' ${shellQuote(envFile)} > /etc/syntrum/agents.env && chmod 0600 /etc/syntrum/agents.env`
    ], 30_000);

    await this.execute(id, [
      "sh", "-c",
      `printf '%s' ${shellQuote(GUEST_BUS_UNIT)} > /etc/systemd/system/syntrum-bus.service`
    ], 30_000);
    await this.execute(id, [
      "systemctl", "daemon-reload"
    ], 30_000);
    // enable + restart, not `enable --now`: on an already-running unit that is
    // a no-op, so a re-provision would leave the daemon holding the previous
    // run's agent grants while the environment file held the new ones.
    await this.execute(id, [
      "systemctl", "enable", "syntrum-bus.service"
    ], 60_000);
    await this.execute(id, [
      "systemctl", "restart", "syntrum-bus.service"
    ], 120_000);

    await this.verifyBus(id, options.agents.length);
    return {
      modules: GUEST_BUS_MODULES.length,
      unitPath: "/etc/systemd/system/syntrum-bus.service",
      socketPath: "/run/syntrum/bus.sock"
    };
  }

  /**
   * Readiness for the bus: the unit is active, the socket exists, and the
   * daemon has actually printed its ready line. A socket file alone can be a
   * leftover from a crashed process.
   */
  async verifyBus(id: string, expectedAgents: number): Promise<void> {
    const reported = await this.execute(id, [
      "sh", "-c",
      // `|| true`: is-active exits non-zero when inactive, and the runner
      // treats that as a command failure that would hide the diagnosis.
      "systemctl is-active syntrum-bus.service || true"
    ], 60_000);
    if (reported.trim() !== "active") {
      const log = await this.execute(id, [
        "sh", "-c",
        "journalctl -u syntrum-bus.service --no-pager -n 20 2>/dev/null || true"
      ], 60_000).catch(() => "");
      throw new Error(
        `Guest bus is ${reported.trim() || "not active"}` +
        (log.trim() ? `; journal: ${log.trim().split("\n").slice(-4).join(" | ")}` : "")
      );
    }

    const socket = await this.execute(id, [
      "sh", "-c",
      "test -S /run/syntrum/bus.sock && echo present || echo missing"
    ], 30_000);
    if (socket.trim() !== "present") {
      throw new Error("Guest bus socket /run/syntrum/bus.sock is missing");
    }

    const ready = await this.execute(id, [
      "sh", "-c",
      "journalctl -u syntrum-bus.service --no-pager 2>/dev/null | grep -c 'syntrum-guest-bus ready' || true"
    ], 60_000);
    if (Number(ready.trim()) < 1) {
      throw new Error("Guest bus has not reported ready; it may be failing to start");
    }
    void expectedAgents;
  }
}
