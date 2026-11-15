import type {
  CloudComputerStatus,
  CommandRunner,
  ComputerDetails,
  ComputerSpec,
  WorkerDriver
} from "./types.js";

const DEFAULT_IMAGE = "images:ubuntu/24.04";
const DEFAULT_STORAGE_POOL = "default";
const CLOUD_INIT_TIMEOUT_MS = 20 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only confirmed absence is idempotent; permission/network/storage failures are not.
export function isIncusNotFound(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("not found") || message.includes("not exist");
}

async function captureFailure(operation: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return isIncusNotFound(error) ? undefined : errorMessage(error);
  }
}

// Display is fixed at :0 so the VNC gateway always knows what to attach to.
// x11vnc -create was rejected: it needs Xvfb (absent from the package list) and
// allocates an unpredictable display.
const DESKTOP_DISPLAY = ":0";

function desktopCloudInit(): string {
  return `#cloud-config
package_update: true
packages:
  - xfce4
  - xfce4-session
  - xfce4-terminal
  - x11vnc
  - xvfb
  - x11-utils
  - dbus-x11
  - novnc
  - websockify
  - git
  - curl
  - ca-certificates
users:
  - name: syntrum
    groups:
      - sudo
    shell: /bin/bash
    lock_passwd: true
write_files:
  - path: /home/syntrum/.xinitrc
    owner: syntrum:syntrum
    permissions: '0644'
    content: |
      #!/bin/sh
      exec startxfce4
  - path: /etc/systemd/system/syntrum-xvfb.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=SYNTRUM virtual X display ${DESKTOP_DISPLAY}
      After=network.target

      [Service]
      Type=simple
      ExecStart=/usr/bin/Xvfb ${DESKTOP_DISPLAY} -screen 0 1280x800x24 -ac -nolisten tcp
      Restart=always
      RestartSec=2

      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/syntrum-desktop.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=SYNTRUM XFCE session
      Requires=syntrum-xvfb.service
      After=syntrum-xvfb.service dbus.service

      [Service]
      Type=simple
      User=syntrum
      Environment=HOME=/home/syntrum
      Environment=DISPLAY=${DESKTOP_DISPLAY}
      ExecStart=/usr/bin/startxfce4
      Restart=always
      RestartSec=3

      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/syntrum-vnc.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=SYNTRUM VNC server for display ${DESKTOP_DISPLAY}
      Requires=syntrum-xvfb.service
      After=syntrum-xvfb.service syntrum-desktop.service

      [Service]
      Type=simple
      User=syntrum
      Environment=HOME=/home/syntrum
      ExecStart=/usr/bin/x11vnc -display ${DESKTOP_DISPLAY} -rfbport 5900 -localhost -nopw -shared -forever -noxdamage
      Restart=always
      RestartSec=2

      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/syntrum-novnc.service
    owner: root:root
    permissions: '0644'
    content: |
      [Unit]
      Description=SYNTRUM noVNC web socket
      After=syntrum-vnc.service

      [Service]
      Type=simple
      ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
      Restart=always
      RestartSec=2

      [Install]
      WantedBy=multi-user.target
runcmd:
  - systemctl enable --now syntrum-xvfb.service
  - systemctl enable --now syntrum-desktop.service
  - systemctl enable --now syntrum-vnc.service
  - systemctl enable --now syntrum-novnc.service
  - systemctl enable --now dbus.service
`;
}

export class IncusWorkerDriver implements WorkerDriver {
  constructor(
    run: CommandRunner,
    private readonly image = DEFAULT_IMAGE,
    private readonly storagePool = DEFAULT_STORAGE_POOL
  ) {
    this.run = (args, timeoutMs) => run(["incus", ...args], timeoutMs);
  }

  private readonly run: CommandRunner;

  async create(spec: ComputerSpec): Promise<void> {
    try {
      await this.run(["create", this.image, spec.id], 120_000);
      await this.run([
        "config", "set", spec.id,
        `limits.cpu=${spec.cpu}`,
        `limits.memory=${spec.memoryMb}MiB`
      ]);
      await this.run([
        "storage", "volume", "create", this.storagePool, spec.storageVolume,
        `size=${spec.diskGb}GiB`
      ], 120_000);
      await this.run([
        "config", "device", "override", spec.id, "root",
        `pool=${this.storagePool}`, "path=/", `size=${spec.diskGb}GiB`
      ]);
      await this.run([
        "config", "device", "add", spec.id, "workspace", "disk",
        `pool=${this.storagePool}`,
        `source=${spec.storageVolume}`,
        "path=/workspace"
      ]);
      if (spec.desktopEnabled !== false) {
        await this.run([
          "config", "set", spec.id, "cloud-init.user-data", desktopCloudInit()
        ]);
        await this.run([
          "config", "device", "add", spec.id, "novnc", "proxy",
          `listen=tcp:127.0.0.1:${spec.desktopPort}`,
          "connect=tcp:127.0.0.1:6080"
        ]);
      }
      await this.run(["start", spec.id], 120_000);
      if (spec.desktopEnabled !== false) {
        await this.run([
          "exec", spec.id, "--", "cloud-init", "status", "--wait"
        ], CLOUD_INIT_TIMEOUT_MS);
      }
    } catch (error) {
      try {
        await this.destroy(spec);
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)}; Cleanup failed: ${errorMessage(cleanupError)}`,
          { cause: cleanupError }
        );
      }
      throw error;
    }
  }

  async start(id: string): Promise<void> {
    await this.run(["start", id], 120_000);
  }

  async stop(id: string): Promise<void> {
    await this.run(["stop", id], 120_000);
  }

  async restart(id: string): Promise<void> {
    await this.run(["restart", id], 120_000);
  }

  async destroy(spec: Pick<ComputerSpec, "id" | "storageVolume">): Promise<void> {
    const containerError = await captureFailure(() =>
      this.run(["delete", spec.id, "--force"], 120_000)
    );
    const volumeError = await captureFailure(() => this.run([
      "storage", "volume", "delete", this.storagePool, spec.storageVolume
    ], 120_000));
    const errors = [
      containerError && `Container delete: ${containerError}`,
      volumeError && `Workspace delete: ${volumeError}`
    ].filter((error): error is string => error !== undefined);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
  }

  async inspect(id: string): Promise<CloudComputerStatus> {
    const output = await this.run(["list", id, "--format=json"]);
    const instances = JSON.parse(output) as { status?: string }[];
    const status = instances[0]?.status?.toLowerCase();
    switch (status) {
      case "running":
        return "running";
      case "stopped":
        return "stopped";
      case "starting":
        return "starting";
      case "stopping":
        return "stopping";
      default:
        return instances.length === 0 ? "deleted" : "error";
    }
  }

  async inspectDetails(id: string): Promise<ComputerDetails> {
    const output = await this.run(["list", id, "--format=json"]);
    const instances = JSON.parse(output) as {
      architecture?: string;
      status?: string;
      state?: {
        memory?: { usage?: number; total?: number };
        cpu?: { usage?: number };
        processes?: number;
        network?: Record<string, { addresses?: { address: string }[] }>;
      };
    }[];
    const instance = instances[0];
    if (!instance) {
      throw new Error("Incus instance was not found");
    }
    const statusText = instance.status?.toLowerCase();
    const status: CloudComputerStatus = statusText === "running"
      ? "running"
      : statusText === "stopped"
        ? "stopped"
        : statusText === "starting"
          ? "starting"
          : statusText === "stopping"
            ? "stopping"
            : "error";
    const addresses = Object.values(instance.state?.network ?? {}).flatMap(network =>
      (network.addresses ?? []).map(item => item.address)
    );
    return {
      status,
      architecture: instance.architecture ?? "unknown",
      ipAddresses: [...new Set(addresses)],
      memoryUsageBytes: instance.state?.memory?.usage ?? 0,
      memoryTotalBytes: instance.state?.memory?.total ?? 0,
      cpuUsageNanoseconds: instance.state?.cpu?.usage ?? 0,
      processes: instance.state?.processes ?? 0
    };
  }

  async execute(id: string, args: readonly string[], timeoutMs?: number): Promise<string> {
    return this.run(["exec", id, "--", ...args], timeoutMs);
  }
}
