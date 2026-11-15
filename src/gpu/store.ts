import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../runtime/database.js";
import type { GpuAllocation, GpuDevice, GpuMetric } from "./types.js";
import { GpuError } from "./types.js";

export class GpuStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path);
  }

  upsertDevice(device: GpuDevice): void {
    this.database.prepare(`
      INSERT INTO worker_gpus (
        worker_host, gpu_uuid, gpu_index, model, total_memory_mb, used_memory_mb,
        utilization_percent, temperature_c, mig_capable, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_host, gpu_uuid) DO UPDATE SET
        gpu_index = excluded.gpu_index,
        model = excluded.model,
        total_memory_mb = excluded.total_memory_mb,
        used_memory_mb = excluded.used_memory_mb,
        utilization_percent = excluded.utilization_percent,
        temperature_c = excluded.temperature_c,
        mig_capable = excluded.mig_capable,
        updated_at = excluded.updated_at
    `).run(
      device.workerHost,
      device.uuid,
      device.index,
      device.model,
      device.totalMemoryMb,
      device.usedMemoryMb,
      device.utilizationPercent,
      device.temperatureC,
      device.migCapable ? 1 : 0,
      new Date().toISOString()
    );
  }

  listDevices(workerHost?: string): GpuDevice[] {
    const rows = this.database.prepare(`
      SELECT * FROM worker_gpus
      ${workerHost ? "WHERE worker_host = ?" : ""}
      ORDER BY worker_host, gpu_index
    `).all(...(workerHost ? [workerHost] : [])) as Record<string, unknown>[];
    return rows.map(row => ({
      workerHost: row.worker_host as string,
      uuid: row.gpu_uuid as string,
      index: row.gpu_index as number,
      model: row.model as string,
      totalMemoryMb: row.total_memory_mb as number,
      usedMemoryMb: row.used_memory_mb as number,
      utilizationPercent: row.utilization_percent as number,
      temperatureC: row.temperature_c as number,
      migCapable: row.mig_capable === 1
    }));
  }

  insertAllocation(allocation: GpuAllocation): void {
    this.database.prepare(`
      INSERT INTO gpu_allocations (
        id, computer_id, worker_host, gpu_uuid, memory_mb, compute_percent,
        mode, workload, duration_sec, status, error, created_at, updated_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      allocation.id,
      allocation.computerId,
      allocation.workerHost,
      allocation.gpuUuid,
      allocation.memoryMb,
      allocation.computePercent,
      allocation.mode,
      allocation.workload,
      allocation.durationSec,
      allocation.status,
      allocation.error ?? null,
      allocation.createdAt,
      allocation.updatedAt,
      allocation.releasedAt ?? null
    );
  }

  getAllocation(id: string): GpuAllocation {
    const row = this.database.prepare(
      "SELECT * FROM gpu_allocations WHERE id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new GpuError(404, "ALLOCATION_NOT_FOUND", "GPU allocation not found");
    }
    return this.allocationFromRow(row);
  }

  listAllocations(activeOnly = false): GpuAllocation[] {
    const rows = this.database.prepare(`
      SELECT * FROM gpu_allocations
      ${activeOnly ? "WHERE status = 'running'" : ""}
      ORDER BY created_at ASC, id ASC
    `).all() as Record<string, unknown>[];
    return rows.map(row => this.allocationFromRow(row));
  }

  updateAllocation(
    id: string,
    status: GpuAllocation["status"],
    error?: string,
    releasedAt?: string
  ): GpuAllocation {
    this.getAllocation(id);
    this.database.prepare(`
      UPDATE gpu_allocations
      SET status = ?, error = ?, updated_at = ?, released_at = COALESCE(?, released_at)
      WHERE id = ?
    `).run(status, error ?? null, new Date().toISOString(), releasedAt ?? null, id);
    return this.getAllocation(id);
  }

  recordMetric(metric: GpuMetric): void {
    this.database.prepare(`
      INSERT INTO gpu_metrics (
        allocation_id, gpu_uuid, utilization_percent, used_memory_mb, temperature_c, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      metric.allocationId ?? null,
      metric.gpuUuid,
      metric.utilizationPercent,
      metric.usedMemoryMb,
      metric.temperatureC,
      metric.recordedAt
    );
  }

  listMetrics(allocationId?: string): GpuMetric[] {
    const rows = this.database.prepare(`
      SELECT * FROM gpu_metrics
      ${allocationId ? "WHERE allocation_id = ?" : ""}
      ORDER BY id ASC
    `).all(...(allocationId ? [allocationId] : [])) as Record<string, unknown>[];
    return rows.map(row => ({
      ...(row.allocation_id ? { allocationId: row.allocation_id as string } : {}),
      gpuUuid: row.gpu_uuid as string,
      utilizationPercent: row.utilization_percent as number,
      usedMemoryMb: row.used_memory_mb as number,
      temperatureC: row.temperature_c as number,
      recordedAt: row.recorded_at as string
    }));
  }

  close(): void {
    this.database.close();
  }

  private allocationFromRow(row: Record<string, unknown>): GpuAllocation {
    return {
      id: row.id as string,
      computerId: row.computer_id as string,
      workerHost: row.worker_host as string,
      gpuUuid: row.gpu_uuid as string,
      memoryMb: row.memory_mb as number,
      computePercent: row.compute_percent as number,
      mode: row.mode as GpuAllocation["mode"],
      workload: row.workload as GpuAllocation["workload"],
      durationSec: row.duration_sec as number,
      status: row.status as GpuAllocation["status"],
      ...(row.error ? { error: row.error as string } : {}),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      ...(row.released_at ? { releasedAt: row.released_at as string } : {})
    };
  }
}
