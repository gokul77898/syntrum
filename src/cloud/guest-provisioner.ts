import { errorMessage } from "../runtime/errors.js";

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

// Pure so the verification step is testable without a guest. Every value is
// validated or derived, never interpolated from caller input unexamined.
export function nodeInstallScript(version: string, platform: string): string {
  if (!NODE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid Node version: ${version}`);
  }
  if (!Object.values(PLATFORM_BY_MACHINE).includes(platform)) {
    throw new Error(`Invalid Node platform: ${platform}`);
  }
  const archive = `node-${version}-${platform}.tar.xz`;
  const installRoot = "/usr/local/lib/nodejs";
  const extracted = `${installRoot}/${archive.replace(/\.tar\.xz$/, "")}`;
  return `set -eu
if [ "$(id -u)" -ne 0 ]; then echo "guest provisioning must run as root" >&2; exit 1; fi
command -v curl >/dev/null 2>&1 || { echo "curl is required in the guest" >&2; exit 1; }
command -v xz >/dev/null 2>&1 || { echo "xz-utils is required in the guest" >&2; exit 1; }
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
/usr/local/bin/node --version
`;
}

export type GuestNodeInstallResult = {
  version: string;
  platform: string;
};

export class GuestProvisioner {
  constructor(private readonly execute: GuestExecutor) {}

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
      ["sh", "-c", nodeInstallScript(version, platform)],
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
}
