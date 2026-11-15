import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../runtime/database.js";
import type { CommandRunner } from "./types.js";

export type WorkerRegistration = {
  id: string;
  host: string;
  sshUser: string;
  architecture: string;
  incusVersion: string;
  status: "healthy" | "unavailable";
  lastSeenAt: string;
  createdAt: string;
};

export async function checkWorkerHealth(
  run: CommandRunner,
  host: string,
  sshUser: string
): Promise<WorkerRegistration> {
  const [clientVersion, serverVersion] = (await run(["incus", "version"])).split("\n").map(line =>
    line.replace(/^Client version:\s*|^Server version:\s*/g, "")
  );
  if (!serverVersion) {
    throw new Error(`Incus server is unavailable on ${host}`);
  }
  const architecture = await run(["uname", "-m"]);
  await run(["incus", "storage", "show", "default"]);
  const now = new Date().toISOString();
  return {
    id: `${sshUser}@${host}`,
    host,
    sshUser,
    architecture,
    incusVersion: serverVersion,
    status: "healthy",
    lastSeenAt: now,
    createdAt: now
  };
}

export class WorkerStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path);
  }

  register(worker: WorkerRegistration): WorkerRegistration {
    this.database.prepare(`
      INSERT INTO workers (
        id, host, ssh_user, architecture, incus_version, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET
        ssh_user = excluded.ssh_user,
        architecture = excluded.architecture,
        incus_version = excluded.incus_version,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at
    `).run(
      worker.id,
      worker.host,
      worker.sshUser,
      worker.architecture,
      worker.incusVersion,
      worker.status,
      worker.lastSeenAt,
      worker.createdAt
    );
    return this.get(worker.id);
  }

  get(id: string): WorkerRegistration {
    const row = this.database.prepare(
      "SELECT * FROM workers WHERE id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("Worker not found");
    }
    return this.fromRow(row);
  }

  list(): WorkerRegistration[] {
    const rows = this.database.prepare(
      "SELECT * FROM workers ORDER BY created_at ASC, id ASC"
    ).all() as Record<string, unknown>[];
    return rows.map(row => this.fromRow(row));
  }

  close(): void {
    this.database.close();
  }

  private fromRow(row: Record<string, unknown>): WorkerRegistration {
    return {
      id: row.id as string,
      host: row.host as string,
      sshUser: row.ssh_user as string,
      architecture: row.architecture as string,
      incusVersion: row.incus_version as string,
      status: row.status as WorkerRegistration["status"],
      lastSeenAt: row.last_seen_at as string,
      createdAt: row.created_at as string
    };
  }
}
