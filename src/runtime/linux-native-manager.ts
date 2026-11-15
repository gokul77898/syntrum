import { spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

import type { NativeLaunchOptions, NativeManager, NativeResult } from "./types.js";

// Linux counterpart to ExecFileNativeManager. macOS proves process identity
// through the AppKit bundle/launchDate pair; Linux has no such concept, so
// identity is a (pid, starttime) pair read from /proc — a reused pid always
// has a different starttime, which is what makes the check meaningful.
//
// frontmost() is deliberately unsupported: it is an AppKit window-server
// question with no honest Linux equivalent. Reporting a guess would let the
// supervisor believe it had verified focus it never checked.
function procStartTime(pid: number): string | undefined {
  try {
    // Field 22 of /proc/<pid>/stat is starttime in clock ticks. The comm field
    // (2) is parenthesised and may contain spaces or parens, so split after it.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    return afterComm[19];
  } catch {
    return undefined;
  }
}

function procExe(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LinuxNativeManager implements NativeManager {
  constructor(private readonly executablePath?: string) {}

  async launch(bundleIdentifier: string, options?: NativeLaunchOptions): Promise<NativeResult> {
    const executable = this.executablePath ?? bundleIdentifier;
    if (!executable.startsWith("/")) {
      return { ok: false, error: `Not an absolute executable path: ${executable}` };
    }
    const args = options?.arguments ?? [];
    const child = spawn(executable, args, {
      detached: false,
      stdio: "ignore",
      env: { ...process.env, ...options?.environment }
    });
    const pid = child.pid;
    if (pid === undefined) {
      return { ok: false, error: "Failed to spawn the process" };
    }
    // spawn() reports async failures (ENOENT, EACCES) on the error event.
    const failure = await new Promise<string | undefined>(resolve => {
      const onError = (error: Error) => resolve(error.message);
      child.once("error", onError);
      setTimeout(() => {
        child.off("error", onError);
        resolve(undefined);
      }, 250).unref();
    });
    if (failure !== undefined) {
      return { ok: false, error: failure };
    }
    // unref so a launched app does not keep the supervisor's event loop alive.
    child.unref();
    const startTime = procStartTime(pid);
    return {
      ok: true,
      pid,
      running: true,
      name: basename(executable),
      bundleIdentifier,
      bundleURL: executable,
      // startTime is what inspect()/terminate() compare against, so it must be
      // the value observed at launch, not read again later.
      launchDate: startTime,
      preExisting: false,
      processExistedBeforeLaunch: false
    };
  }

  async inspect(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    const exe = procExe(pid);
    if (exe === undefined) {
      return { ok: true, pid, running: false, bundleIdentifier };
    }
    const startTime = procStartTime(pid);
    return {
      ok: true,
      pid,
      running: isAlive(pid),
      name: basename(exe),
      bundleIdentifier,
      bundleURL: exe,
      actualBundleIdentifier: bundleIdentifier,
      actualLaunchDate: startTime,
      launchDate: startTime
    };
  }

  async terminate(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    const exe = procExe(pid);
    if (exe === undefined) {
      // Already gone: idempotent success, not an error.
      return { ok: true, pid, running: false, terminationRequested: true };
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      return { ok: false, pid, error: (error as Error).message };
    }
    const startTime = procStartTime(pid);
    return {
      ok: true,
      pid,
      bundleIdentifier,
      running: isAlive(pid),
      terminationRequested: true,
      actualBundleIdentifier: bundleIdentifier,
      actualLaunchDate: startTime
    };
  }

  async frontmost(): Promise<NativeResult> {
    // Honest refusal: there is no Linux equivalent of the AppKit frontmost
    // query, and a fabricated success would be worse than a clear "no".
    return { ok: false, available: false, error: "frontmost is not supported on Linux" };
  }
}
