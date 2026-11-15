import { execFile } from "node:child_process";
import { resolve } from "node:path";

import type { NativeLaunchOptions, NativeManager, NativeResult } from "./types.js";

const DEFAULT_MANAGER_PATH = resolve(process.cwd(), ".build/app-manager");
const NATIVE_TIMEOUT_MS = 20_000;
const MAX_NATIVE_OUTPUT = 1024 * 1024;

export class ExecFileNativeManager implements NativeManager {
  constructor(private readonly executablePath = DEFAULT_MANAGER_PATH) {}

  launch(bundleIdentifier: string, options?: NativeLaunchOptions): Promise<NativeResult> {
    const configuration = {
      ...(options?.arguments !== undefined ? { arguments: options.arguments } : {}),
      ...(options?.environment !== undefined ? { environment: options.environment } : {}),
      ...(options?.activates !== undefined ? { activates: options.activates } : {}),
      ...(options?.newInstance !== undefined ? { newInstance: options.newInstance } : {})
    };
    const args = ["launch", bundleIdentifier];
    if (Object.keys(configuration).length > 0) {
      args.push(JSON.stringify(configuration));
    }
    return this.run(args);
  }

  inspect(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    return this.run(["inspect", String(pid), bundleIdentifier]);
  }

  terminate(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    return this.run(["terminate", String(pid), bundleIdentifier]);
  }

  frontmost(): Promise<NativeResult> {
    return this.run(["frontmost"]);
  }

  private run(args: string[]): Promise<NativeResult> {
    return new Promise((resolveResult, reject) => {
      execFile(
        this.executablePath,
        args,
        {
          encoding: "utf8",
          timeout: NATIVE_TIMEOUT_MS,
          maxBuffer: MAX_NATIVE_OUTPUT,
          shell: false
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim() || error.message));
            return;
          }

          try {
            const result: unknown = JSON.parse(stdout);
            if (
              typeof result !== "object" ||
              result === null ||
              Array.isArray(result) ||
              typeof (result as NativeResult).ok !== "boolean"
            ) {
              reject(new Error("Invalid native manager response"));
              return;
            }
            resolveResult(result as NativeResult);
          } catch {
            reject(new Error("Invalid native manager response"));
          }
        }
      );
    });
  }
}
