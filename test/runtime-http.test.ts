import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createRuntimeHttpServer } from "../src/server.js";
import {
  RuntimeSupervisor,
  silentLogger,
  type NativeManager,
  type NativeResult
} from "../src/runtime/index.js";

class HttpNativeManager implements NativeManager {
  private readonly launchDate = "2026-01-01T00:00:00.000Z";

  async launch(bundleIdentifier: string): Promise<NativeResult> {
    return {
      ok: true,
      pid: 4321,
      name: "HTTP Example",
      bundleIdentifier,
      bundleURL: "/Applications/HTTPExample.app",
      launchDate: this.launchDate,
      preExisting: false
    };
  }

  async inspect(pid: number, bundleIdentifier: string): Promise<NativeResult> {
    return { ok: true, pid, bundleIdentifier, launchDate: this.launchDate, running: true };
  }

  async terminate(pid: number): Promise<NativeResult> {
    return { ok: true, pid, running: false, terminationRequested: true };
  }

  async frontmost(): Promise<NativeResult> {
    return { ok: true, available: true, pid: 1, bundleIdentifier: "com.example.Frontmost" };
  }
}

test("HTTP API supports stable IDs, legacy PID routes, events, and bounded structured errors", async () => {
  const supervisor = new RuntimeSupervisor({
    databasePath: ":memory:",
    nativeManager: new HttpNativeManager(),
    logger: silentLogger,
    pollIntervalMs: 0
  });
  const server = createRuntimeHttpServer(supervisor, { logger: silentLogger });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  async function request(path: string, init?: RequestInit): Promise<{
    status: number;
    body: Record<string, unknown>;
    requestId: string | null;
  }> {
    const response = await fetch(`${base}${path}`, init);
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
      requestId: response.headers.get("x-request-id")
    };
  }

  try {
    const health = await request("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.sessions, 0);
    assert.ok(health.requestId);

    const created = await request("/sessions", { method: "POST" });
    assert.equal(created.status, 201);
    const session = created.body.session as { id: string };
    assert.ok(session.id);

    const launched = await request(`/sessions/${session.id}/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleIdentifier: "com.example.Http" })
    });
    assert.equal(launched.status, 201);
    const application = launched.body.application as { id: string; pid: number };
    assert.match(application.id, /^[0-9a-f-]{36}$/);

    const byId = await request(`/sessions/${session.id}/apps/${application.id}`);
    const byPid = await request(`/sessions/${session.id}/apps/${application.pid}`);
    assert.equal(byId.status, 200);
    assert.equal(byPid.status, 200);
    assert.equal(
      (byId.body.application as { id: string }).id,
      (byPid.body.application as { id: string }).id
    );

    const events = await request(`/sessions/${session.id}/events?after=0&limit=10`);
    assert.equal(events.status, 200);
    assert.equal(events.body.count, 2);

    const invalidSession = await request("/sessions/not-a-uuid/apps");
    assert.equal(invalidSession.status, 400);
    assert.equal(invalidSession.body.code, "INVALID_SESSION_ID");
    assert.equal(invalidSession.body.error, "Invalid session ID");
    assert.equal(invalidSession.body.requestId, invalidSession.requestId);

    const invalidJson = await request(`/sessions/${session.id}/apps`, {
      method: "POST",
      body: "{not-json"
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.code, "INVALID_JSON");

    const oversized = await request(`/sessions/${session.id}/apps`, {
      method: "POST",
      body: JSON.stringify({ bundleIdentifier: "com.example.Large", padding: "x".repeat(20_000) })
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, "REQUEST_BODY_TOO_LARGE");

    const terminated = await request(`/sessions/${session.id}/apps/${application.id}`, {
      method: "DELETE"
    });
    assert.equal(terminated.status, 200);
    assert.equal(
      (terminated.body.application as { status: string }).status,
      "exited"
    );
    const terminatedAgain = await request(`/sessions/${session.id}/apps/${application.pid}`, {
      method: "DELETE"
    });
    assert.equal(terminatedAgain.status, 200);
    assert.equal(terminatedAgain.body.message, "Application already exited");

    const listed = await request("/sessions");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.count, 1);
    assert.equal((listed.body.sessions as { applications: unknown[] }[])[0].applications.length, 1);
  } finally {
    server.close();
    await once(server, "close");
    await supervisor.close();
  }
});
