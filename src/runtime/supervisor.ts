import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./database.js";
import { RuntimeError, errorMessage } from "./errors.js";
import { log, silentLogger } from "./logger.js";
import { ExecFileNativeManager } from "./native-manager.js";
import type {
  AgentGrant,
  ApplicationStatus,
  LaunchResult,
  Logger,
  ManagedApplication,
  NativeLaunchOptions,
  NativeManager,
  ProcessIdentity,
  ProcessOrigin,
  RuntimeEvent,
  Session,
  SessionResource,
  TerminationResult
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DEFAULT_DATABASE_PATH = resolve(process.cwd(), "data/runtime.sqlite");
const DEFAULT_POLL_INTERVAL_MS = 5000;

type ApplicationRow = {
  id: string;
  session_id: string;
  name: string;
  bundle_identifier: string;
  bundle_url: string;
  pid: number;
  launch_date: string | null;
  launched_at: string;
  status: ApplicationStatus;
  process_origin: ProcessOrigin;
  process_identity: ProcessIdentity;
  last_checked_at: string | null;
  last_error: string | null;
  exited_at: string | null;
  termination_requested_at: string | null;
};

type SessionRow = {
  id: string;
  status: "active" | "stopped";
  created_at: string;
};

type EventRow = {
  id: number;
  session_id: string;
  application_id: string | null;
  type: string;
  created_at: string;
  data_json: string;
};

type LifecyclePatch = {
  status?: ApplicationStatus;
  processOrigin?: ProcessOrigin;
  processIdentity?: ProcessIdentity;
  lastCheckedAt?: string;
  lastError?: string | null;
  exitedAt?: string | null;
  terminationRequestedAt?: string | null;
};

export type RuntimeSupervisorOptions = {
  databasePath?: string;
  nativeManager?: NativeManager;
  logger?: Logger;
  pollIntervalMs?: number;
  now?: () => Date;
  createId?: () => string;
};

export class RuntimeSupervisor {
  private readonly database: DatabaseSync;
  private readonly nativeManager: NativeManager;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly inspections = new Map<string, Promise<ManagedApplication>>();
  private readonly launches = new Map<string, Promise<LaunchResult>>();
  private readonly terminations = new Map<string, Promise<TerminationResult>>();
  private readonly applicationOperations = new Map<string, Promise<void>>();
  private pollTimer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private closeOperation?: Promise<void>;
  private started = false;
  private closed = false;

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.database = openDatabase(options.databasePath ?? DEFAULT_DATABASE_PATH);
    this.nativeManager = options.nativeManager ?? new ExecFileNativeManager();
    this.logger = options.logger ?? silentLogger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("Runtime supervisor is closed");
    }
    if (this.started) {
      return;
    }

    this.started = true;
    await this.reconcile();
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        void this.reconcile().catch(error => {
          log(this.logger, "warn", "runtime.reconciliation_failed", errorMessage(
            error,
            "Application reconciliation failed"
          ));
        });
      }, this.pollIntervalMs);
      this.pollTimer.unref();
    }
  }

  close(): Promise<void> {
    if (this.closeOperation) {
      return this.closeOperation;
    }
    this.closed = true;
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.closeOperation = this.performClose();
    return this.closeOperation;
  }

  private async performClose(): Promise<void> {
    await Promise.allSettled([
      ...(this.reconciliation ? [this.reconciliation] : []),
      ...this.launches.values(),
      ...this.inspections.values(),
      ...this.terminations.values(),
      ...this.applicationOperations.values()
    ]);
    this.database.close();
  }

  createSession(): Session {
    const id = this.createId();
    const createdAt = this.timestamp();
    this.database.prepare(
      "INSERT INTO sessions (id, status, created_at) VALUES (?, 'active', ?)"
    ).run(id, createdAt);
    this.recordEvent(id, null, "session.created", { createdAt });
    log(this.logger, "info", "session.created", "Session created", { sessionId: id });
    return { id, status: "active", createdAt, applications: [] };
  }

  countSessions(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number };
    return row.count;
  }

  getSession(sessionId: string): Session {
    assertUuid(sessionId, "session");
    const row = this.database.prepare(
      "SELECT id, status, created_at FROM sessions WHERE id = ?"
    ).get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new RuntimeError(404, "SESSION_NOT_FOUND", "Session not found");
    }

    const applications = this.database.prepare(`
      SELECT * FROM applications
      WHERE session_id = ?
      ORDER BY launched_at ASC, id ASC
    `).all(sessionId) as unknown as ApplicationRow[];

    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      applications: applications.map(applicationFromRow)
    };
  }

  listSessions(): Session[] {
    const rows = this.database.prepare(
      "SELECT id FROM sessions ORDER BY created_at ASC, id ASC"
    ).all() as { id: string }[];
    return rows.map(row => this.getSession(row.id));
  }

  saveSessionResource(resource: SessionResource): void {
    assertUuid(resource.sessionId, "session");
    this.requireSession(resource.sessionId);
    if (
      !isAbsolute(resource.workspaceRoot) ||
      !isAbsolute(resource.adapterSocketPath) ||
      resource.adapterToken.length < 16 ||
      resource.adapterToken.length > 512
    ) {
      throw new RuntimeError(400, "INVALID_SESSION_RESOURCE", "Invalid session resource");
    }
    this.database.prepare(`
      INSERT INTO session_resources (
        session_id, workspace_root, adapter_socket_path, adapter_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        adapter_socket_path = excluded.adapter_socket_path,
        adapter_token = excluded.adapter_token,
        updated_at = excluded.updated_at
    `).run(
      resource.sessionId,
      resource.workspaceRoot,
      resource.adapterSocketPath,
      resource.adapterToken,
      resource.createdAt,
      resource.updatedAt
    );
  }

  getSessionResource(sessionId: string): SessionResource | undefined {
    assertUuid(sessionId, "session");
    this.requireSession(sessionId);
    const row = this.database.prepare(
      "SELECT * FROM session_resources WHERE session_id = ?"
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? sessionResourceFromRow(row) : undefined;
  }

  listSessionResources(): SessionResource[] {
    const rows = this.database.prepare(
      "SELECT * FROM session_resources ORDER BY created_at ASC, session_id ASC"
    ).all() as Record<string, unknown>[];
    return rows.map(sessionResourceFromRow);
  }

  saveAgentGrant(grant: AgentGrant): void {
    assertUuid(grant.sessionId, "session");
    this.requireSession(grant.sessionId);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(grant.agentId) ||
      !/^[0-9a-f]{64}$/.test(grant.tokenHash) ||
      grant.capabilities.length === 0 ||
      grant.capabilities.some(capability => typeof capability !== "string")
    ) {
      throw new RuntimeError(400, "INVALID_AGENT_GRANT", "Invalid agent grant");
    }
    this.database.prepare(`
      INSERT INTO agent_grants (
        agent_id, session_id, token_hash, capabilities_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id = excluded.session_id,
        token_hash = excluded.token_hash,
        capabilities_json = excluded.capabilities_json
    `).run(
      grant.agentId,
      grant.sessionId,
      grant.tokenHash,
      JSON.stringify(grant.capabilities),
      grant.createdAt
    );
  }

  getAgentGrant(agentId: string): AgentGrant | undefined {
    const row = this.database.prepare(
      "SELECT * FROM agent_grants WHERE agent_id = ?"
    ).get(agentId) as Record<string, unknown> | undefined;
    return row ? agentGrantFromRow(row) : undefined;
  }

  recordSessionEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown>
  ): void {
    assertUuid(sessionId, "session");
    this.requireSession(sessionId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(type)) {
      throw new RuntimeError(400, "INVALID_EVENT_TYPE", "Invalid event type");
    }
    this.recordEvent(sessionId, null, type, data);
  }

  async listApplications(sessionId: string, refresh = true): Promise<ManagedApplication[]> {
    const applications = this.getSession(sessionId).applications;
    if (!refresh) {
      return applications;
    }
    return Promise.all(applications.map(application => this.refreshApplication(application.id)));
  }

  async getApplication(sessionId: string, applicationId: string, refresh = true): Promise<ManagedApplication> {
    assertUuid(sessionId, "session");
    assertUuid(applicationId, "application");
    this.requireSession(sessionId);
    const application = this.findApplication(sessionId, applicationId);
    return refresh ? this.refreshApplication(application.id) : application;
  }

  async getApplicationByReference(sessionId: string, reference: string, refresh = true): Promise<ManagedApplication> {
    assertUuid(sessionId, "session");
    this.requireSession(sessionId);
    const application = this.findApplicationByReference(sessionId, reference);
    return refresh ? this.refreshApplication(application.id) : application;
  }

  frontmostApplication(): ReturnType<NativeManager["frontmost"]> {
    return this.nativeManager.frontmost();
  }

  async launchApplication(
    sessionId: string,
    bundleIdentifier: string,
    options?: NativeLaunchOptions
  ): Promise<LaunchResult> {
    assertUuid(sessionId, "session");
    validateBundleIdentifier(bundleIdentifier);
    const key = `${sessionId}:${bundleIdentifier}`;
    const pending = this.launches.get(key);
    if (pending) {
      return pending;
    }

    const operation = this.performLaunch(sessionId, bundleIdentifier, options).finally(() => {
      if (this.launches.get(key) === operation) {
        this.launches.delete(key);
      }
    });
    this.launches.set(key, operation);
    return operation;
  }

  async terminateApplication(sessionId: string, reference: string): Promise<TerminationResult> {
    const registered = this.findApplicationByReferenceAfterValidation(sessionId, reference);
    this.assertTerminationAllowed(registered);
    if (registered.status === "exited") {
      return { application: registered, alreadyExited: true };
    }

    const pending = this.terminations.get(registered.id);
    if (pending) {
      return pending;
    }

    const operation = this.withApplicationOperation(
      registered.id,
      () => this.performTermination(registered.id)
    ).finally(() => {
      if (this.terminations.get(registered.id) === operation) {
        this.terminations.delete(registered.id);
      }
    });
    this.terminations.set(registered.id, operation);
    return operation;
  }

  private async performTermination(applicationId: string): Promise<TerminationResult> {
    let application = this.requireApplication(applicationId);
    this.assertTerminationAllowed(application);
    if (application.status === "exited") {
      return { application, alreadyExited: true };
    }

    application = await this.performInspection(application);
    this.assertTerminationAllowed(application);
    if (application.status === "exited") {
      return { application, alreadyExited: true };
    }

    let result;
    try {
      result = await this.nativeManager.terminate(application.pid, application.bundleIdentifier);
    } catch (error) {
      const message = errorMessage(error, "Termination failed");
      this.updateLifecycle(application.id, {
        status: "unknown",
        lastCheckedAt: this.timestamp(),
        lastError: message
      });
      this.recordEvent(application.id, "application.termination_failed", { message });
      throw new RuntimeError(502, "NATIVE_MANAGER_ERROR", message);
    }

    const checkedAt = this.timestamp();
    const actualLaunchDate = result.actualLaunchDate ?? result.launchDate;
    const bundleMismatch = result.actualBundleIdentifier !== undefined &&
      result.actualBundleIdentifier !== application.bundleIdentifier;
    const launchDateMismatch = application.launchDate !== undefined &&
      actualLaunchDate !== undefined &&
      !sameLaunchDate(application.launchDate, actualLaunchDate);
    const mismatch = bundleMismatch || launchDateMismatch;

    if (!result.ok || mismatch) {
      const message = result.error ?? (mismatch
        ? "Process identity does not match the registered application"
        : "Termination rejected");
      this.updateLifecycle(application.id, {
        status: mismatch ? "unknown" : application.status,
        processIdentity: mismatch ? "mismatch" : undefined,
        lastCheckedAt: checkedAt,
        lastError: message
      });
      this.recordEvent(application.id, mismatch ? "application.identity_mismatch" : "application.termination_failed", {
        pid: application.pid,
        actualBundleIdentifier: result.actualBundleIdentifier,
        actualLaunchDate,
        message
      });
      const updated = this.requireApplication(application.id);
      throw new RuntimeError(
        409,
        mismatch ? "PROCESS_IDENTITY_MISMATCH" : "TERMINATION_REJECTED",
        message,
        { application: updated }
      );
    }

    if (result.running === false) {
      this.updateLifecycle(application.id, {
        status: "exited",
        lastCheckedAt: checkedAt,
        lastError: null,
        exitedAt: checkedAt
      });
      this.recordEvent(application.id, "application.exited", { reason: "terminated" });
      return {
        application: this.requireApplication(application.id),
        alreadyExited: false,
        terminationRequested: result.terminationRequested
      };
    }

    if (result.running === true && result.terminationRequested === false) {
      const message = "Termination was not accepted by the application";
      this.updateLifecycle(application.id, {
        status: "running",
        lastCheckedAt: checkedAt,
        lastError: message,
        terminationRequestedAt: null
      });
      this.recordEvent(application.id, "application.termination_failed", { message });
      throw new RuntimeError(409, "TERMINATION_NOT_ACCEPTED", message, {
        application: this.requireApplication(application.id)
      });
    }

    if (result.running === true) {
      this.updateLifecycle(application.id, {
        status: "termination_requested",
        lastCheckedAt: checkedAt,
        lastError: null,
        terminationRequestedAt: checkedAt
      });
      this.recordEvent(application.id, "application.termination_requested", {
        pid: application.pid
      });
      return {
        application: this.requireApplication(application.id),
        alreadyExited: false,
        terminationRequested: result.terminationRequested
      };
    }

    const message = "Native manager returned an invalid termination response";
    this.updateLifecycle(application.id, {
      status: "unknown",
      lastCheckedAt: checkedAt,
      lastError: message
    });
    throw new RuntimeError(502, "NATIVE_MANAGER_INVALID_RESPONSE", message);
  }

  private assertTerminationAllowed(application: ManagedApplication): void {
    if (application.processIdentity === "mismatch") {
      throw new RuntimeError(
        409,
        "PROCESS_IDENTITY_MISMATCH",
        "Refusing to terminate a reused or mismatched PID",
        { application }
      );
    }
    if (application.status === "exited") {
      return;
    }
    if (application.processOrigin === "shared") {
      throw new RuntimeError(
        409,
        "APPLICATION_SHARED",
        "Refusing to terminate an application shared by multiple sessions",
        { application }
      );
    }
    if (application.processOrigin === "pre_existing") {
      throw new RuntimeError(
        409,
        "APPLICATION_PRE_EXISTING",
        "Refusing to terminate an application that was already running",
        { application }
      );
    }
    if (application.processOrigin === "unknown") {
      throw new RuntimeError(
        409,
        "PROCESS_ORIGIN_UNKNOWN",
        "Refusing to terminate an application whose launch origin is unknown",
        { application }
      );
    }
    if (application.processIdentity !== "verified" || !application.launchDate) {
      throw new RuntimeError(
        409,
        "PROCESS_IDENTITY_UNVERIFIED",
        "Refusing to terminate without a verified AppKit launchDate",
        { application }
      );
    }
    if (application.status === "unknown") {
      throw new RuntimeError(
        409,
        "PROCESS_STATE_UNKNOWN",
        application.lastError ?? "Application state could not be verified",
        { application }
      );
    }
  }

  reconcile(): Promise<void> {
    if (this.reconciliation) {
      return this.reconciliation;
    }

    const operation = this.performReconciliation().finally(() => {
      if (this.reconciliation === operation) {
        this.reconciliation = undefined;
      }
    });
    this.reconciliation = operation;
    return operation;
  }

  listEvents(
    sessionId: string,
    after = 0,
    limit = 100,
    typePrefix?: string
  ): RuntimeEvent[] {
    assertUuid(sessionId, "session");
    this.requireSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RuntimeError(400, "INVALID_EVENT_CURSOR", "Event cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RuntimeError(400, "INVALID_EVENT_LIMIT", "Event limit must be between 1 and 500");
    }
    if (typePrefix !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(typePrefix)) {
      throw new RuntimeError(400, "INVALID_EVENT_TYPE", "Invalid event type prefix");
    }

    const rows = this.database.prepare(`
      SELECT id, session_id, application_id, type, created_at, data_json
      FROM events
      WHERE session_id = ? AND id > ?
        AND (? IS NULL OR type LIKE ? || '%')
      ORDER BY id ASC
      LIMIT ?
    `).all(
      sessionId,
      after,
      typePrefix ?? null,
      typePrefix ?? null,
      limit
    ) as unknown as EventRow[];

    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      ...(row.application_id ? { applicationId: row.application_id } : {}),
      type: row.type,
      createdAt: row.created_at,
      data: JSON.parse(row.data_json) as Record<string, unknown>
    }));
  }

  private async performLaunch(
    sessionId: string,
    bundleIdentifier: string,
    options?: NativeLaunchOptions
  ): Promise<LaunchResult> {
    const session = this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new RuntimeError(409, "SESSION_NOT_ACTIVE", "Session is not active");
    }

    const existing = this.database.prepare(`
      SELECT * FROM applications
      WHERE session_id = ? AND bundle_identifier = ?
      ORDER BY launched_at DESC, id DESC
      LIMIT 1
    `).get(sessionId, bundleIdentifier) as ApplicationRow | undefined;

    if (existing && existing.status !== "exited" && existing.process_identity !== "mismatch") {
      const application = await this.refreshApplication(existing.id);
      if (application.status !== "exited" && application.processIdentity !== "mismatch") {
        return { application, created: false };
      }
    }

    let result;
    try {
      result = await this.nativeManager.launch(bundleIdentifier, options);
    } catch (error) {
      const message = errorMessage(error, "Application launch failed");
      log(this.logger, "error", "application.launch_failed", message, { sessionId, bundleIdentifier });
      throw new RuntimeError(502, "NATIVE_MANAGER_ERROR", message);
    }

    if (!result.ok) {
      throw new RuntimeError(422, "APPLICATION_LAUNCH_FAILED", result.error ?? "Application launch failed");
    }
    if (
      !Number.isSafeInteger(result.pid) ||
      (result.pid ?? 0) <= 0 ||
      (result.pid ?? 0) > 2_147_483_647 ||
      !result.name ||
      !result.bundleIdentifier ||
      result.bundleIdentifier !== bundleIdentifier ||
      !result.bundleURL ||
      (result.launchDate !== undefined && !isValidLaunchDate(result.launchDate))
    ) {
      throw new RuntimeError(
        502,
        "NATIVE_MANAGER_INVALID_RESPONSE",
        "Native manager returned inconsistent application identity"
      );
    }

    const pid = result.pid as number;
    const launchDate = result.launchDate;
    const otherRecords = this.database.prepare(`
      SELECT id, launch_date FROM applications
      WHERE session_id <> ? AND pid = ? AND bundle_identifier = ?
        AND status <> 'exited' AND process_identity <> 'mismatch'
    `).all(sessionId, pid, bundleIdentifier) as {
      id: string;
      launch_date: string | null;
    }[];
    const sharedRecords = otherRecords.filter(record =>
      !launchDate || !record.launch_date || sameLaunchDate(launchDate, record.launch_date)
    );
    const reusedRecords = otherRecords.filter(record => !sharedRecords.includes(record));
    const preExisting = result.preExisting ?? result.alreadyRunning ??
      result.processReused ?? result.processExistedBeforeLaunch;
    const processOrigin: ProcessOrigin = sharedRecords.length > 0
      ? "shared"
      : preExisting === true
        ? "pre_existing"
        : preExisting === false
          ? "launched"
          : "unknown";

    if (sharedRecords.length > 0) {
      const markShared = this.database.prepare(
        "UPDATE applications SET process_origin = 'shared', updated_at = ? WHERE id = ?"
      );
      for (const record of sharedRecords) {
        markShared.run(this.timestamp(), record.id);
        this.recordEvent(record.id, "application.shared", { sessionId });
      }
    }
    for (const record of reusedRecords) {
      const message = "PID was reused by a newer application process";
      this.updateLifecycle(record.id, {
        status: "unknown",
        processIdentity: "mismatch",
        lastCheckedAt: this.timestamp(),
        lastError: message
      });
      this.recordEvent(record.id, "application.identity_mismatch", {
        pid,
        actualLaunchDate: launchDate,
        message
      });
    }

    const id = this.createId();
    const launchedAt = this.timestamp();
    const status: ApplicationStatus = result.running === false ? "exited" : "running";
    const processIdentity: ProcessIdentity = launchDate ? "verified" : "unverified";
    this.database.prepare(`
      INSERT INTO applications (
        id, session_id, name, bundle_identifier, bundle_url, pid, launch_date, launched_at,
        status, process_origin, process_identity, last_checked_at, exited_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      result.name,
      result.bundleIdentifier,
      result.bundleURL,
      pid,
      launchDate ?? null,
      launchedAt,
      status,
      processOrigin,
      processIdentity,
      launchedAt,
      status === "exited" ? launchedAt : null,
      launchedAt,
      launchedAt
    );
    const application = this.requireApplication(id);
    this.recordEvent(id, "application.registered", {
      pid,
      bundleIdentifier,
      processOrigin,
      preExisting
    });
    log(this.logger, "info", "application.registered", "Application launch registered", {
      sessionId,
      applicationId: id,
      pid,
      processOrigin
    });
    return { application, created: true };
  }

  private refreshApplication(applicationId: string): Promise<ManagedApplication> {
    const pending = this.inspections.get(applicationId);
    if (pending) {
      return pending;
    }
    const application = this.requireApplication(applicationId);
    if (application.status === "exited" || application.processIdentity === "mismatch") {
      return Promise.resolve(application);
    }

    const operation = this.withApplicationOperation(applicationId, () => {
      const current = this.requireApplication(applicationId);
      if (current.status === "exited" || current.processIdentity === "mismatch") {
        return current;
      }
      return this.performInspection(current);
    }).finally(() => {
      if (this.inspections.get(applicationId) === operation) {
        this.inspections.delete(applicationId);
      }
    });
    this.inspections.set(applicationId, operation);
    return operation;
  }

  private withApplicationOperation<T>(
    applicationId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const previous = this.applicationOperations.get(applicationId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tracked = result.then(() => undefined, () => undefined);
    this.applicationOperations.set(applicationId, tracked);
    void tracked.then(() => {
      if (this.applicationOperations.get(applicationId) === tracked) {
        this.applicationOperations.delete(applicationId);
      }
    });
    return result;
  }

  private async performInspection(application: ManagedApplication): Promise<ManagedApplication> {
    const checkedAt = this.timestamp();
    try {
      const result = await this.nativeManager.inspect(application.pid, application.bundleIdentifier);
      const actualBundleIdentifier = result.actualBundleIdentifier ?? result.bundleIdentifier;
      const actualLaunchDate = result.actualLaunchDate ?? result.launchDate;
      const bundleMismatch = actualBundleIdentifier !== undefined &&
        actualBundleIdentifier !== application.bundleIdentifier;
      const launchDateMismatch = application.launchDate !== undefined &&
        actualLaunchDate !== undefined &&
        !sameLaunchDate(application.launchDate, actualLaunchDate);
      const identityMismatch = bundleMismatch || launchDateMismatch;

      if (!result.ok || identityMismatch) {
        const message = result.error ?? (bundleMismatch
          ? "PID does not match expected application"
          : launchDateMismatch
            ? "AppKit launchDate does not match the registered process"
            : "Inspection failed");
        this.updateLifecycle(application.id, {
          status: "unknown",
          processIdentity: identityMismatch ? "mismatch" : undefined,
          lastCheckedAt: checkedAt,
          lastError: message
        });
        if (application.processIdentity !== "mismatch" || application.lastError !== message) {
          this.recordEvent(application.id, identityMismatch ? "application.identity_mismatch" : "application.inspection_failed", {
            pid: application.pid,
            expectedBundleIdentifier: application.bundleIdentifier,
            actualBundleIdentifier,
            expectedLaunchDate: application.launchDate,
            actualLaunchDate,
            message
          });
        }
        return this.requireApplication(application.id);
      }

      if (result.running === false) {
        this.updateLifecycle(application.id, {
          status: "exited",
          lastCheckedAt: checkedAt,
          lastError: null,
          exitedAt: checkedAt
        });
        this.recordEvent(application.id, "application.exited", { reason: "inspect" });
        return this.requireApplication(application.id);
      }

      if (result.running === true) {
        if (
          !application.launchDate ||
          !actualLaunchDate ||
          !isValidLaunchDate(actualLaunchDate)
        ) {
          const message = application.launchDate
            ? "Native manager did not return a valid AppKit launchDate"
            : "Application has no persisted AppKit launchDate";
          this.updateLifecycle(application.id, {
            status: "unknown",
            processIdentity: "unverified",
            lastCheckedAt: checkedAt,
            lastError: message
          });
          this.recordEvent(application.id, "application.inspection_failed", {
            pid: application.pid,
            expectedLaunchDate: application.launchDate,
            actualLaunchDate,
            message
          });
          return this.requireApplication(application.id);
        }

        const nextStatus = application.status === "termination_requested"
          ? "termination_requested"
          : "running";
        this.updateLifecycle(application.id, {
          status: nextStatus,
          processIdentity: "verified",
          lastCheckedAt: checkedAt,
          lastError: null,
          exitedAt: null
        });
        if (
          application.status !== nextStatus ||
          application.processIdentity !== "verified" ||
          application.lastError
        ) {
          this.recordEvent(application.id, "application.running", { pid: application.pid });
        }
        return this.requireApplication(application.id);
      }

      const message = "Native manager returned an invalid inspection response";
      this.updateLifecycle(application.id, {
        status: "unknown",
        lastCheckedAt: checkedAt,
        lastError: message
      });
      return this.requireApplication(application.id);
    } catch (error) {
      const message = errorMessage(error, "Inspection failed");
      this.updateLifecycle(application.id, {
        status: "unknown",
        lastCheckedAt: checkedAt,
        lastError: message
      });
      if (application.status !== "unknown" || application.lastError !== message) {
        this.recordEvent(application.id, "application.inspection_failed", { message });
      }
      log(this.logger, "warn", "application.inspection_failed", message, {
        applicationId: application.id,
        pid: application.pid
      });
      return this.requireApplication(application.id);
    }
  }

  private async performReconciliation(): Promise<void> {
    const rows = this.database.prepare(`
      SELECT a.id FROM applications a
      JOIN sessions s ON s.id = a.session_id
      WHERE s.status = 'active' AND a.status <> 'exited'
        AND a.process_identity <> 'mismatch'
      ORDER BY a.launched_at ASC
    `).all() as { id: string }[];

    for (const row of rows) {
      if (this.closed) {
        break;
      }
      await this.refreshApplication(row.id);
    }
    if (rows.length > 0) {
      log(this.logger, "info", "runtime.reconciled", "Application reconciliation completed", {
        inspected: rows.length
      });
    }
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.database.prepare(
      "SELECT id, status, created_at FROM sessions WHERE id = ?"
    ).get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new RuntimeError(404, "SESSION_NOT_FOUND", "Session not found");
    }
    return row;
  }

  private requireApplication(applicationId: string): ManagedApplication {
    const row = this.database.prepare(
      "SELECT * FROM applications WHERE id = ?"
    ).get(applicationId) as ApplicationRow | undefined;
    if (!row) {
      throw new RuntimeError(404, "APPLICATION_NOT_FOUND", "Application not found");
    }
    return applicationFromRow(row);
  }

  private findApplication(sessionId: string, applicationId: string): ManagedApplication {
    const row = this.database.prepare(
      "SELECT * FROM applications WHERE session_id = ? AND id = ?"
    ).get(sessionId, applicationId) as ApplicationRow | undefined;
    if (!row) {
      throw new RuntimeError(
        404,
        "APPLICATION_NOT_IN_SESSION",
        "Application does not belong to this session"
      );
    }
    return applicationFromRow(row);
  }

  private findApplicationByReferenceAfterValidation(sessionId: string, reference: string): ManagedApplication {
    assertUuid(sessionId, "session");
    this.requireSession(sessionId);
    return this.findApplicationByReference(sessionId, reference);
  }

  private findApplicationByReference(sessionId: string, reference: string): ManagedApplication {
    if (UUID_PATTERN.test(reference)) {
      return this.findApplication(sessionId, reference);
    }
    if (!/^\d+$/.test(reference)) {
      throw new RuntimeError(400, "INVALID_APPLICATION_ID", "Invalid application ID or PID");
    }
    const pid = Number(reference);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
      throw new RuntimeError(400, "INVALID_PID", "Invalid PID");
    }

    const row = this.database.prepare(`
      SELECT * FROM applications
      WHERE session_id = ? AND pid = ?
      ORDER BY launched_at DESC, id DESC
      LIMIT 1
    `).get(sessionId, pid) as ApplicationRow | undefined;
    if (!row) {
      throw new RuntimeError(
        404,
        "APPLICATION_NOT_IN_SESSION",
        "Application does not belong to this session"
      );
    }
    return applicationFromRow(row);
  }

  private updateLifecycle(applicationId: string, patch: LifecyclePatch): void {
    const assignments = ["updated_at = ?"];
    const values: (string | number | null)[] = [this.timestamp()];
    const columns: Record<string, string> = {
      status: "status",
      processOrigin: "process_origin",
      processIdentity: "process_identity",
      lastCheckedAt: "last_checked_at",
      lastError: "last_error",
      exitedAt: "exited_at",
      terminationRequestedAt: "termination_requested_at"
    };

    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key as keyof LifecyclePatch];
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(value);
      }
    }
    values.push(applicationId);
    this.database.prepare(
      `UPDATE applications SET ${assignments.join(", ")} WHERE id = ?`
    ).run(...values);
  }

  private recordEvent(
    applicationOrSessionId: string,
    type: string,
    data: Record<string, unknown>
  ): void;
  private recordEvent(
    sessionId: string,
    applicationId: string | null,
    type: string,
    data: Record<string, unknown>
  ): void;
  private recordEvent(
    first: string,
    second: string | null,
    third?: string | Record<string, unknown>,
    fourth?: Record<string, unknown>
  ): void {
    let sessionId: string;
    let applicationId: string | null;
    let type: string;
    let data: Record<string, unknown>;

    if (typeof third === "string") {
      sessionId = first;
      applicationId = second;
      type = third;
      data = fourth ?? {};
    } else {
      applicationId = first;
      type = second as string;
      data = third ?? {};
      const row = this.database.prepare(
        "SELECT session_id FROM applications WHERE id = ?"
      ).get(applicationId) as { session_id: string } | undefined;
      if (!row) {
        throw new Error("Cannot record event for an unknown application");
      }
      sessionId = row.session_id;
    }

    this.database.prepare(`
      INSERT INTO events (session_id, application_id, type, created_at, data_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, applicationId, type, this.timestamp(), JSON.stringify(data));
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function sessionResourceFromRow(row: Record<string, unknown>): SessionResource {
  return {
    sessionId: row.session_id as string,
    workspaceRoot: row.workspace_root as string,
    adapterSocketPath: row.adapter_socket_path as string,
    adapterToken: row.adapter_token as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  };
}

function agentGrantFromRow(row: Record<string, unknown>): AgentGrant {
  return {
    agentId: row.agent_id as string,
    sessionId: row.session_id as string,
    tokenHash: row.token_hash as string,
    capabilities: JSON.parse(row.capabilities_json as string) as string[],
    createdAt: row.created_at as string
  };
}

function applicationFromRow(row: ApplicationRow): ManagedApplication {
  return {
    id: row.id,
    name: row.name,
    bundleIdentifier: row.bundle_identifier,
    bundleURL: row.bundle_url,
    pid: row.pid,
    ...(row.launch_date ? { launchDate: row.launch_date } : {}),
    launchedAt: row.launched_at,
    status: row.status,
    processOrigin: row.process_origin,
    processIdentity: row.process_identity,
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.exited_at ? { exitedAt: row.exited_at } : {}),
    ...(row.termination_requested_at
      ? { terminationRequestedAt: row.termination_requested_at }
      : {})
  };
}

function isValidLaunchDate(value: string): boolean {
  return value.length <= 128 && Number.isFinite(Date.parse(value));
}

function sameLaunchDate(left: string, right: string): boolean {
  return isValidLaunchDate(left) && isValidLaunchDate(right) &&
    Date.parse(left) === Date.parse(right);
}

function assertUuid(value: string, kind: "session" | "application"): void {
  if (!UUID_PATTERN.test(value)) {
    throw new RuntimeError(
      400,
      kind === "session" ? "INVALID_SESSION_ID" : "INVALID_APPLICATION_ID",
      `Invalid ${kind} ID`
    );
  }
}

function validateBundleIdentifier(bundleIdentifier: string): void {
  if (!BUNDLE_IDENTIFIER_PATTERN.test(bundleIdentifier)) {
    throw new RuntimeError(400, "INVALID_BUNDLE_IDENTIFIER", "Invalid bundleIdentifier");
  }
}
