import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../runtime/database.js";
import { CloudError, type CloudComputer, type CloudComputerStatus } from "./types.js";

export class CloudComputerStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path);
  }

  insert(computer: CloudComputer): void {
    this.database.prepare(`
      INSERT INTO cloud_computers (
        id, worker_host, image, cpu, memory_mb, disk_gb, storage_volume,
        desktop_port, desktop_enabled, status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      computer.id,
      computer.workerHost,
      computer.image,
      computer.cpu,
      computer.memoryMb,
      computer.diskGb,
      computer.storageVolume,
      computer.desktopPort,
      computer.desktopEnabled ? 1 : 0,
      computer.status,
      computer.error ?? null,
      computer.createdAt,
      computer.updatedAt
    );
  }

  get(id: string): CloudComputer {
    const row = this.database.prepare(
      "SELECT * FROM cloud_computers WHERE id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new CloudError(404, "COMPUTER_NOT_FOUND", "Cloud computer not found");
    }
    return this.fromRow(row);
  }

  list(includeDeleted = false): CloudComputer[] {
    const rows = this.database.prepare(`
      SELECT * FROM cloud_computers
      ${includeDeleted ? "" : "WHERE status <> 'deleted'"}
      ORDER BY created_at ASC, id ASC
    `).all() as Record<string, unknown>[];
    return rows.map(row => this.fromRow(row));
  }

  updateStatus(id: string, status: CloudComputerStatus, error?: string): CloudComputer {
    this.get(id);
    this.database.prepare(
      "UPDATE cloud_computers SET status = ?, error = ?, updated_at = ? WHERE id = ?"
    ).run(status, error ?? null, new Date().toISOString(), id);
    return this.get(id);
  }

  nextDesktopPort(): number {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(desktop_port), 19999) + 1 AS port FROM cloud_computers"
    ).get() as { port: number };
    if (row.port > 60_000) {
      throw new CloudError(503, "PORT_POOL_EXHAUSTED", "No desktop proxy ports remain");
    }
    return row.port;
  }

  close(): void {
    this.database.close();
  }

  private fromRow(row: Record<string, unknown>): CloudComputer {
    return {
      id: row.id as string,
      workerHost: row.worker_host as string,
      image: row.image as string,
      cpu: row.cpu as number,
      memoryMb: row.memory_mb as number,
      diskGb: row.disk_gb as number,
      storageVolume: row.storage_volume as string,
      desktopPort: row.desktop_port as number,
      desktopEnabled: row.desktop_enabled !== 0,
      status: row.status as CloudComputerStatus,
      ...(row.error ? { error: row.error as string } : {}),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }
}
