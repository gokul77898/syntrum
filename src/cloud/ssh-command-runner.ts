import { execFile } from "node:child_process";

import type { CommandRunner } from "./types.js";

export type SshWorkerOptions = {
  host: string;
  user: string;
  knownHostsPath?: string;
  identityFile?: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createSshCommandRunner(options: SshWorkerOptions): CommandRunner {
  if (!/^[A-Za-z0-9._-]+$/.test(options.user)) {
    throw new TypeError("Invalid SSH user");
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(options.host)) {
    throw new TypeError("Invalid SSH host");
  }

  return (args, timeoutMs = 30_000, execute = execFile) => new Promise((resolve, reject) => {
    const sshArgs = [
      "-n",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      ...(options.knownHostsPath
        ? ["-o", `UserKnownHostsFile=${options.knownHostsPath}`]
        : []),
      ...(options.identityFile
        ? ["-i", options.identityFile, "-o", "IdentitiesOnly=yes"]
        : []),
      `${options.user}@${options.host}`,
      "--",
      ...args.map(shellQuote)
    ];
    execute(
      "ssh",
      sshArgs,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        shell: false
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || "Remote command failed"));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}
