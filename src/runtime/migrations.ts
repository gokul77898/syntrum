export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const migrations: Migration[] = [
  {
    version: 1,
    name: "sessions_applications_events",
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        bundle_identifier TEXT NOT NULL,
        bundle_url TEXT NOT NULL,
        pid INTEGER NOT NULL CHECK (pid > 0),
        launched_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('running', 'termination_requested', 'exited', 'unknown')
        ),
        process_origin TEXT NOT NULL CHECK (
          process_origin IN ('launched', 'pre_existing', 'shared', 'unknown')
        ),
        process_identity TEXT NOT NULL CHECK (
          process_identity IN ('unverified', 'verified', 'mismatch')
        ),
        last_checked_at TEXT,
        last_error TEXT,
        exited_at TEXT,
        termination_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX applications_session_id
        ON applications(session_id, launched_at DESC);
      CREATE INDEX applications_pid
        ON applications(session_id, pid, launched_at DESC);
      CREATE INDEX applications_lifecycle
        ON applications(status, process_identity);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      );

      CREATE INDEX events_session_id
        ON events(session_id, id);
    `
  },
  {
    version: 2,
    name: "application_launch_identity",
    sql: `
      ALTER TABLE applications ADD COLUMN launch_date TEXT;

      UPDATE applications
      SET process_identity = 'unverified'
      WHERE status <> 'exited';
    `
  },
  {
    version: 3,
    name: "dual_head_resources_and_agents",
    sql: `
      CREATE TABLE session_resources (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_root TEXT NOT NULL UNIQUE,
        adapter_socket_path TEXT NOT NULL UNIQUE,
        adapter_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_grants (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
        created_at TEXT NOT NULL
      );

      CREATE INDEX agent_grants_session_id
        ON agent_grants(session_id);
    `
  },
  {
    version: 4,
    name: "cloud_computers",
    sql: `
      CREATE TABLE cloud_computers (
        id TEXT PRIMARY KEY,
        worker_host TEXT NOT NULL,
        image TEXT NOT NULL,
        cpu INTEGER NOT NULL CHECK (cpu > 0),
        memory_mb INTEGER NOT NULL CHECK (memory_mb > 0),
        disk_gb INTEGER NOT NULL CHECK (disk_gb > 0),
        storage_volume TEXT NOT NULL UNIQUE,
        desktop_port INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX cloud_computers_status
        ON cloud_computers(status);
    `
  },
  {
    version: 5,
    name: "gpu_inventory_allocations_metrics",
    sql: `
      CREATE TABLE worker_gpus (
        worker_host TEXT NOT NULL,
        gpu_uuid TEXT NOT NULL,
        gpu_index INTEGER NOT NULL,
        model TEXT NOT NULL,
        total_memory_mb INTEGER NOT NULL,
        used_memory_mb INTEGER NOT NULL,
        utilization_percent INTEGER NOT NULL,
        temperature_c INTEGER NOT NULL,
        mig_capable INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (worker_host, gpu_uuid)
      );

      CREATE TABLE gpu_allocations (
        id TEXT PRIMARY KEY,
        computer_id TEXT NOT NULL REFERENCES cloud_computers(id),
        worker_host TEXT NOT NULL,
        gpu_uuid TEXT NOT NULL,
        memory_mb INTEGER NOT NULL CHECK (memory_mb > 0),
        compute_percent INTEGER NOT NULL,
        mode TEXT NOT NULL,
        workload TEXT NOT NULL,
        duration_sec INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE INDEX gpu_allocations_active
        ON gpu_allocations(worker_host, gpu_uuid, status);

      CREATE TABLE gpu_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_id TEXT REFERENCES gpu_allocations(id),
        gpu_uuid TEXT NOT NULL,
        utilization_percent INTEGER NOT NULL,
        used_memory_mb INTEGER NOT NULL,
        temperature_c INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX gpu_metrics_allocation
        ON gpu_metrics(allocation_id, id);
    `
  },
  {
    version: 6,
    name: "worker_registration_and_desktop_optional",
    sql: `
      ALTER TABLE cloud_computers
        ADD COLUMN desktop_enabled INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL UNIQUE,
        ssh_user TEXT NOT NULL,
        architecture TEXT NOT NULL,
        incus_version TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 7,
    name: "accounts_and_computer_ownership",
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        -- SHA-256 of the token, never the token itself. Tokens are 32 random
        -- bytes, so there is no low-entropy guess to slow down; a password
        -- would need scrypt instead.
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        -- Per-account ceiling so one tenant cannot fill the shared pool.
        max_computers INTEGER NOT NULL CHECK (max_computers > 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX accounts_token_hash ON accounts(token_hash);

      -- Nullable on purpose: rows created before accounts existed belong to
      -- nobody, so only the operator can see them. Visible-to-all would be the
      -- unsafe default.
      ALTER TABLE cloud_computers ADD COLUMN owner_id TEXT REFERENCES accounts(id);

      CREATE INDEX cloud_computers_owner
        ON cloud_computers(owner_id, created_at);
    `
  },
];
