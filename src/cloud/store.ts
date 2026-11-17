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
        desktop_port, desktop_enabled, status, error, created_at, updated_at,
        owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      computer.updatedAt,
      computer.ownerId ?? null
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

  /**
   * `ownerId` of undefined means every computer, which is the operator's view.
   * A string scopes to that account; null scopes to the unowned rows, which
   * only the operator can ask for.
   */
  list(options: { ownerId?: string | null; includeDeleted?: boolean } = {}): CloudComputer[] {
    const where: string[] = [];
    const values: (string | null)[] = [];
    if (!options.includeDeleted) {
      where.push("status <> 'deleted'");
    }
    if (options.ownerId !== undefined) {
      if (options.ownerId === null) {
        where.push("owner_id IS NULL");
      } else {
        where.push("owner_id = ?");
        values.push(options.ownerId);
      }
    }
    const rows = this.database.prepare(`
      SELECT * FROM cloud_computers
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at ASC, id ASC
    `).all(...values) as Record<string, unknown>[];
    return rows.map(row => this.fromRow(row));
  }

  updateStatus(id: string, status: CloudComputerStatus, error?: string): CloudComputer {
    this.get(id);
    this.database.prepare(
      "UPDATE cloud_computers SET status = ?, error = ?, updated_at = ? WHERE id = ?"
    ).run(status, error ?? null, new Date().toISOString(), id);
    return this.get(id);
  }

  /**
   * Records that the guest agent bus was installed and verified.
   *
   * Read back only by agentAccess; `CloudComputer` deliberately does not carry
   * the token, so it cannot leak into a list or a status response.
   */
  setGuestAgentToken(id: string, token: string): void {
    this.get(id);
    this.database.prepare(
      "UPDATE cloud_computers SET guest_agent_token = ?, updated_at = ? WHERE id = ?"
    ).run(token, new Date().toISOString(), id);
  }

  guestAgentToken(id: string): string | undefined {
    const row = this.database.prepare(
      "SELECT guest_agent_token FROM cloud_computers WHERE id = ?"
    ).get(id) as { guest_agent_token?: string | null } | undefined;
    return row?.guest_agent_token ?? undefined;
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
      ...(row.owner_id ? { ownerId: row.owner_id as string } : {}),
      ...(row.error ? { error: row.error as string } : {}),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }
}
