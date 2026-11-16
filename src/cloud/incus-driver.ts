import type {
  CloudComputerStatus,
  CommandRunner,
  ComputerDetails,
  ComputerSpec,
  WorkerDriver
} from "./types.js";
import { guestSocketPath } from "./guest-bridge.js";

// The /cloud variant is required: it ships cloud-init, which the desktop path
// depends on. The plain images:ubuntu/24.04 does not, so `cloud-init status`
// fails with "Command not found" and no desktop is ever provisioned.
const DEFAULT_IMAGE = "images:ubuntu/24.04/cloud";
const DEFAULT_STORAGE_POOL = "default";
const CLOUD_INIT_TIMEOUT_MS = 20 * 60_000;
// `incus copy` duplicates the whole root filesystem, which is far larger than
// any single command's timeout allows for.
const COPY_TIMEOUT_MS = 20 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Restricted Incus projects usually deny proxy devices. The desktop is
// reachable over the container IP regardless, so a denied proxy is not fatal —
// but any other failure is.
const PROXY_FORBIDDEN = /proxy devices are forbidden/i;

// Only confirmed absence is idempotent; permission/network/state failures are not.
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

// Order matters: verifyDesktop maps systemctl output positionally onto this.
const DESKTOP_UNITS = [
  "syntrum-xvfb.service",
  "syntrum-desktop.service",
  "syntrum-vnc.service",
  "syntrum-novnc.service"
] as const;

// aptConf is injected only when the worker clock is known to be skewed. A
// future-dated clock makes apt reject its own Release files; this relaxes the
// date check but not signature verification. It is an environment workaround,
// not a product feature — fix the clock instead.
//
// websockify binds 0.0.0.0 inside the guest because the restricted project
// forbids proxy devices, so the worker reaches it over the container IP rather
// than a worker-loopback forward. x11vnc stays on guest loopback: only
// websockify is ever exposed, and only on the container's private bridge.
function desktopCloudInit(desktopPort: number, aptConf?: string): string {
  return `#cloud-config
package_update: true
${aptConf ? `apt:\n  conf: |\n${aptConf.split("\n").map(line => `    ${line}`).join("\n")}\n` : ""}packages:
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
  # The macOS-like surface: Arc theme, Papirus icons, Inter font, Plank dock.
  # epiphany-browser is the only browser here; see syntrum-theme for why its
  # sandbox has to be off in this container.
  - arc-theme
  - papirus-icon-theme
  - fonts-inter
  - plank
  - epiphany-browser
users:
  - name: syntrum
    groups:
      - sudo
    shell: /bin/bash
    lock_passwd: true
# write-files runs before users-groups, so nothing here may be owned by
# syntrum — a user-owned entry fails silently and aborts every file after it.
write_files:
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
      # A desktop that exits is a fault, even when it exits cleanly: a stranded
      # epiphany/plank leaves the screen with no panel, wallpaper or dock.
      Restart=always
      RestartSec=3
      # XFCE keeps its session when it has no session manager to talk to, so the
      # default 90s deadline leaves a whole second desktop stacked behind every
      # restart. Stop it hard and fast instead.
      KillMode=control-group
      TimeoutStopSec=5

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
      ExecStart=/usr/bin/websockify --web=/usr/share/novnc 0.0.0.0:${desktopPort} 127.0.0.1:5900
      Restart=always
      RestartSec=2

      [Install]
      WantedBy=multi-user.target
  # Applied by runcmd after the session exists. Kept as a script because xfconf
  # property names are unforgiving: XFCE reads /Net/ThemeName, not /ThemeName,
  # and xfconf-query silently creates the wrong one without complaining.
  - path: /usr/local/bin/syntrum-theme
    owner: root:root
    permissions: '0755'
    content: |
      #!/bin/bash
      # SYNTRUM guest desktop appearance. Idempotent; safe to re-run.
      set -u
      export DISPLAY=${DESKTOP_DISPLAY}

      as_user() { su syntrum -c "HOME=/home/syntrum DISPLAY=${DESKTOP_DISPLAY} $1"; }

      # xfconf writes the per-channel XML itself, so this works with no daemon
      # and no session running.
      as_user '
        xfconf-query -c xsettings -p /Net/ThemeName -s Arc
        xfconf-query -c xsettings -p /Net/IconThemeName -s Papirus-Dark
        xfconf-query -c xsettings -p /Gtk/FontName -s "Inter 11"
        xfconf-query -c xsettings -p /Gtk/MonospaceFontName -s "Monospace 11"
        xfconf-query -c xsettings -p /Gtk/CursorThemeName -s Adwaita
        xfconf-query -c xfwm4 -p /general/theme -s Arc
        xfconf-query -c xfwm4 -p /general/button_layout -s "CHM|"
        xfconf-query -c xfwm4 -p /general/use_compositing -s false -t bool --create
      '

      # GTK apps read this directly; xfsettingsd is not always publishing.
      for v in 3.0 4.0; do
        install -d -o syntrum -g syntrum /home/syntrum/.config/gtk-$v
        cat > /home/syntrum/.config/gtk-$v/settings.ini <<'INI'
      [Settings]
      gtk-theme-name=Arc
      gtk-icon-theme-name=Papirus-Dark
      gtk-font-name=Inter 11
      gtk-cursor-theme-name=Adwaita
      gtk-cursor-theme-size=24
      gtk-decoration-layout=close,minimize:
      INI
        chown syntrum:syntrum /home/syntrum/.config/gtk-$v/settings.ini
      done

      # Backdrop: a solid colour, because no SVG pixbuf loader is installed and
      # the stock xfce-shapes.svg wallpaper therefore paints nothing at all.
      as_user '
        for ws in workspace0 workspace1 workspace2 workspace3; do
          p=/backdrop/screen0/monitorscreen/$ws
          xfconf-query -c xfce4-desktop -p $p/image-style -s 0 -t int --create
          xfconf-query -c xfce4-desktop -p $p/color-style -s 0 -t int --create
          xfconf-query -c xfce4-desktop -p $p/rgba1 --create \
            -s 0.113 -t double -s 0.125 -t double -s 0.145 -t double -s 1.0 -t double
        done
      '

      install -d -o syntrum -g syntrum /home/syntrum/.local/share/applications
      install -d -o syntrum -g syntrum /home/syntrum/.config/autostart
      install -d -o syntrum -g syntrum /home/syntrum/.config/plank/dock1/launchers

      # Google as a dock launcher rather than a window at login: a browser that
      # autostarts covers the whole desktop and hides the panel and dock.
      cat > /home/syntrum/.local/share/applications/syntrum-google.desktop <<'DESKTOP'
      [Desktop Entry]
      Type=Application
      Name=Google
      Comment=Open Google in the guest desktop
      Exec=env WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 epiphany-browser --new-window https://www.google.com
      Icon=epiphany
      Terminal=false
      Categories=Network;WebBrowser;
      DESKTOP
      cat > /home/syntrum/.config/plank/dock1/launchers/gl-google.dockitem <<'DOCKITEM'
      [PlankDockItemPreferences]
      Launcher=file:///home/syntrum/.local/share/applications/syntrum-google.desktop
      DOCKITEM
      cat > /home/syntrum/.config/plank/dock1/launchers/gl-files.dockitem <<'DOCKITEM'
      [PlankDockItemPreferences]
      Launcher=file:///usr/share/applications/thunar.desktop
      DOCKITEM
      cat > /home/syntrum/.config/plank/dock1/launchers/gl-terminal.dockitem <<'DOCKITEM'
      [PlankDockItemPreferences]
      Launcher=file:///usr/share/applications/xfce4-terminal.desktop
      DOCKITEM
      cat > /home/syntrum/.config/autostart/plank.desktop <<'DESKTOP'
      [Desktop Entry]
      Type=Application
      Name=Plank
      Comment=SYNTRUM dock
      Exec=plank
      Terminal=false
      X-GNOME-Autostart-enabled=true
      DESKTOP

      chown -R syntrum:syntrum /home/syntrum/.config/plank /home/syntrum/.config/autostart \
        /home/syntrum/.local/share/applications
runcmd:
  # Appearance first: with no xfconf daemon running yet these writes go straight
  # to XML, so the session below starts up already themed.
  - /usr/local/bin/syntrum-theme
  - systemctl enable --now syntrum-xvfb.service
  - systemctl enable --now syntrum-desktop.service
  - systemctl enable --now syntrum-vnc.service
  - systemctl enable --now syntrum-novnc.service
  # Re-apply on a live session too: xfsettingsd watches xfconf, so this covers
  # the case where the session came up before the theme was written.
  - /usr/local/bin/syntrum-theme
`;
}

export class IncusWorkerDriver implements WorkerDriver {
  constructor(
    run: CommandRunner,
    private readonly image = DEFAULT_IMAGE,
    private readonly storagePool = DEFAULT_STORAGE_POOL,
    private readonly aptConf?: string
  ) {
    this.run = (args, timeoutMs) => run(["incus", ...args], timeoutMs);
  }

  private readonly run: CommandRunner;

  async create(spec: ComputerSpec): Promise<void> {
    let containerCreated = false;
    try {
      await this.run(["create", spec.image ?? this.image, spec.id], 120_000);
      containerCreated = true;
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
          "config", "set", spec.id, "cloud-init.user-data",
          desktopCloudInit(spec.desktopPort, this.aptConf)
        ]);
        // Best-effort: the proxy gives a worker-loopback path, which is the
        // cleanest one when permitted. A forbidden proxy is expected on a
        // restricted project and does not by itself prevent a working desktop.
        try {
          await this.run([
            "config", "device", "add", spec.id, "novnc", "proxy",
            `listen=tcp:127.0.0.1:${spec.desktopPort}`,
            "connect=tcp:0.0.0.0:6080"
          ]);
        } catch (error) {
          if (!PROXY_FORBIDDEN.test(errorMessage(error))) throw error;
        }
      }
      // Exposed before start so the socket exists on the worker as soon as the
      // guest's bus begins listening; the device is inert until then.
      await this.exposeGuestBus(spec.id, guestSocketPath(spec.id));
      await this.run(["start", spec.id], 120_000);
      if (spec.desktopEnabled !== false) {
        // cloud-init exits non-zero when it records *recoverable* errors too —
        // a clean desktop build still trips the benign scripts_user warning
        // while reporting "status: done". Its exit code is therefore not a
        // readiness signal, and verifyDesktop below is the real gate. Wait for
        // it regardless, and treat only an explicit error status as fatal.
        const reported = await this.run([
          "exec", spec.id, "--", "sh", "-c",
          "cloud-init status --wait >/dev/null 2>&1; cloud-init status"
        ], CLOUD_INIT_TIMEOUT_MS);
        if (/^status: error$/m.test(reported)) {
          throw new Error(`cloud-init reported an error: ${reported.trim()}`);
        }
      }
    } catch (error) {
      // cloud-init's log is the only place a provisioning failure is
      // explained, and destroying the container destroys it. Surface the
      // reason before cleanup so a failed run is diagnosable at all.
      const reason = containerCreated
        ? await this.provisioningFailureReason(spec).catch(() => "")
        : "";
      try {
        await this.destroy(spec);
      } catch (cleanupError) {
        throw new Error(
          `${errorMessage(error)}${reason}; Cleanup failed: ${errorMessage(cleanupError)}`,
          { cause: cleanupError }
        );
      }
      throw reason
        ? new Error(`${errorMessage(error)}${reason}`, { cause: error })
        : error;
    }
  }

  // Best-effort. Absent or unreadable logs simply contribute nothing.
  private async provisioningFailureReason(spec: ComputerSpec): Promise<string> {
    const log = await this.run([
      "exec", spec.id, "--", "sh", "-c",
      "tail -n 60 /var/log/cloud-init-output.log 2>/dev/null || true"
    ], 60_000);
    const tail = log.split("\n")
      .filter(line => line.trim().length > 0 && line.trim() !== ".")
      .slice(-8)
      .join(" | ");
    return tail ? `; cloud-init log tail: ${tail}` : "";
  }

  // cloud-init exiting 0 only means the units were written and started.
  // A desktop that is not actually up must fail, not be reported ready.
  async verifyDesktop(id: string): Promise<void> {
    // `|| true`: systemctl is-active exits 4 when any unit is inactive, and the
    // command runner treats a non-zero exit as a failure — which would throw
    // the raw runner message and skip the per-unit diagnosis below.
    const output = await this.run([
      "exec", id, "--", "sh", "-c",
      "systemctl is-active syntrum-xvfb.service syntrum-desktop.service " +
      "syntrum-vnc.service syntrum-novnc.service || true"
    ]);
    const states = output.trim().split(/\s+/);
    const failed = DESKTOP_UNITS.filter((_, index) => states[index] !== "active");
    if (states.length !== DESKTOP_UNITS.length || failed.length > 0) {
      throw new Error(
        `Desktop services not active: ${
          failed.length > 0 ? failed.join(", ") : output.trim() || "no output"
        }`
      );
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

  // Workspace branching: a copy of a stopped container carries the whole root
  // filesystem, so /workspace state forks with it. Instance-only, by design —
  // copying the storage volume as well would double disk use per fork.
  async fork(sourceId: string, targetId: string): Promise<void> {
    await this.run(["copy", sourceId, targetId], COPY_TIMEOUT_MS);
    await this.run(["start", targetId], 120_000);
  }

  async destroy(spec: Pick<ComputerSpec, "id" | "storageVolume">): Promise<void> {
    // The proxy device dies with the container, but the socket file it created
    // on the worker does not: without this, a re-created computer with the same
    // id would find a stale socket in its way. Removed after the container, so
    // a failed create that never added the device does not gain a call here.
    const containerError = await captureFailure(() =>
      this.run(["delete", spec.id, "--force"], 120_000)
    );
    await this.unexposeGuestBus(spec.id);
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

  /**
   * Exposes the guest's agent bus socket on the worker's filesystem.
   *
   * The socket inside the guest is not on a shared mount, so a proxy device is
   * what makes it dialable from the worker at all — and that is the only path
   * the host bridge can tunnel over. `bind=host` creates the socket on the
   * worker, and mode 0600 keeps it to the operator account rather than every
   * local user on the worker.
   *
   * A restricted project may forbid proxy devices, exactly as it does for the
   * desktop's port proxy. That is tolerated here: the computer is still usable,
   * and a later tunnel attempt reports the missing socket clearly rather than
   * failing the whole provision.
   */
  async exposeGuestBus(id: string, socketPath: string): Promise<void> {
    try {
      await this.run([
        "config", "device", "add", id, "agent-bus", "proxy",
        `listen=unix:${socketPath}`,
        "connect=unix:/run/syntrum/bus.sock",
        "bind=host",
        "mode=0600"
      ]);
    } catch (error) {
      if (!PROXY_FORBIDDEN.test(errorMessage(error))) throw error;
    }
  }

  async unexposeGuestBus(id: string): Promise<void> {
    await captureFailure(() =>
      this.run(["config", "device", "remove", id, "agent-bus"], 60_000)
    );
  }
}
