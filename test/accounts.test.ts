import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AccountStore,
  CloudComputerService,
  CloudComputerStore,
  OPERATOR,
  hashToken,
  ownsComputer,
  tokenMatches,
  type Caller,
  type CloudComputer,
  type WorkerDriver
} from "../src/cloud/index.js";

/**
 * Accounts and computer ownership.
 *
 * The isolation cases are the point: before accounts, one operator token reached
 * every computer, so a second person saw the first person's machines.
 */

function database(): string {
  return join(mkdtempSync(join(tmpdir(), "syntrum-accounts-")), "cloud.sqlite");
}

function inertDriver(): WorkerDriver {
  return {
    async create() {},
    async start() {},
    async stop() {},
    async restart() {},
    async inspect() { return "running"; },
    async destroy() {},
    async execute() { return ""; }
  };
}

function serviceWith(path: string) {
  return new CloudComputerService({
    store: new CloudComputerStore(path),
    driver: inertDriver(),
    workerHost: "gokul@worker"
  });
}

test("an account token is stored only as a hash", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  t.after(() => { accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const { account, token } = accounts.create("team-a");
  assert.equal(account.name, "team-a");
  assert.equal(account.status, "active");

  // The plaintext token must not appear in any file the database writes. WAL
  // mode means the row may still be in the -wal sidecar, not the main file.
  const { readFileSync } = await import("node:fs");
  const bytes = Buffer.concat([
    readFileSync(path),
    ...["-wal", "-shm"]
      .map(suffix => join(path + suffix))
      .filter(existsSync)
      .map(sidecar => readFileSync(sidecar))
  ]);
  assert.equal(bytes.includes(Buffer.from(token)), false, "token is not stored in plaintext");
  assert.ok(bytes.includes(Buffer.from(hashToken(token))), "the hash is stored");
});

test("a token resolves to its account, and an unknown token to nothing", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  t.after(() => { accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const { account, token } = accounts.create("team-a");
  assert.equal(accounts.findByToken(token)?.id, account.id);
  assert.equal(accounts.findByToken("deadbeef"), undefined);
  assert.equal(accounts.findByToken(""), undefined);
});

test("rotating a token invalidates the previous one", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  t.after(() => { accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const { account, token } = accounts.create("team-a");
  const rotated = accounts.rotateToken(account.id);
  assert.notEqual(rotated, token);
  assert.equal(accounts.findByToken(token), undefined, "old token stops working");
  assert.equal(accounts.findByToken(rotated)?.id, account.id);
});

test("an account sees only its own computers", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a");
  const b = accounts.create("team-b");
  const callerA: Caller = { kind: "account", account: a.account };
  const callerB: Caller = { kind: "account", account: b.account };

  const mine = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false }, callerA);

  assert.deepEqual(service.list(callerA).map(c => c.id), [mine.id]);
  assert.deepEqual(service.list(callerB), [], "another account sees nothing");
  assert.equal(service.list(OPERATOR).length, 1, "the operator sees everything");
});

test("another account's computer is reported as missing, not forbidden", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a");
  const b = accounts.create("team-b");
  const callerA: Caller = { kind: "account", account: a.account };
  const callerB: Caller = { kind: "account", account: b.account };
  const mine = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false }, callerA);

  // 404 rather than 403: a distinguishable "forbidden" would confirm which IDs
  // exist, letting one tenant enumerate another's computers.
  for (const attempt of [
    () => service.get(mine.id, callerB),
    () => service.access(mine.id, callerB),
    () => service.details(mine.id, callerB)
  ]) {
    await assert.rejects(
      async () => attempt(),
      (error: any) => error.code === "COMPUTER_NOT_FOUND" && error.statusCode === 404
    );
  }
});

test("lifecycle operations are refused across accounts", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a");
  const b = accounts.create("team-b");
  const callerA: Caller = { kind: "account", account: a.account };
  const callerB: Caller = { kind: "account", account: b.account };
  const mine = await service.create({ cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false }, callerA);

  const notFound = (error: any) => error.code === "COMPUTER_NOT_FOUND";
  await assert.rejects(service.start(mine.id, callerB), notFound);
  await assert.rejects(service.stop(mine.id, callerB), notFound);
  await assert.rejects(service.restart(mine.id, callerB), notFound);
  // execute validates synchronously, so it throws before returning a promise.
  assert.rejects(async () => service.execute(mine.id, ["uname"], undefined, callerB), notFound);
  await assert.rejects(service.destroy(mine.id, callerB), notFound);

  // Refused, not deleted: the owner's record is untouched.
  assert.equal(service.get(mine.id, callerA).status, "running");
});

test("an account cannot exceed its own computer limit", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a", 2);
  const callerA: Caller = { kind: "account", account: a.account };
  const input = { cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false };

  await service.create(input, callerA);
  await service.create(input, callerA);
  await assert.rejects(
    service.create(input, callerA),
    (error: any) => error.code === "COMPUTER_LIMIT_REACHED" && error.statusCode === 429
  );

  // The limit is per account: another tenant is unaffected.
  const b = accounts.create("team-b", 1);
  await service.create(input, { kind: "account", account: b.account });
});

test("a deleted computer does not count against the limit", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a", 1);
  const callerA: Caller = { kind: "account", account: a.account };
  const input = { cpu: 1, memoryMb: 512, diskGb: 5, desktopEnabled: false };

  const first = await service.create(input, callerA);
  await service.destroy(first.id, callerA);
  // Otherwise deleting a computer would permanently spend the account's quota.
  await service.create(input, callerA);
});

test("a disabled account cannot create computers", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  const a = accounts.create("team-a");
  accounts.setStatus(a.account.id, "disabled");
  const caller: Caller = { kind: "account", account: accounts.get(a.account.id) };
  await assert.rejects(
    service.create({ desktopEnabled: false }, caller),
    (error: any) => error.code === "ACCOUNT_DISABLED"
  );
});

test("computers with no owner belong to the operator alone", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  const service = serviceWith(path);
  t.after(() => { service.close(); accounts.close(); rmSync(path, { recursive: true, force: true }); });

  // An unowned row stands in for a computer created before accounts existed.
  const legacy: CloudComputer = {
    id: "11111111-2222-4333-8444-555555555555",
    workerHost: "gokul@worker",
    image: "images:ubuntu/24.04/cloud",
    cpu: 1, memoryMb: 512, diskGb: 5,
    storageVolume: "syntrum-workspace-legacy",
    desktopPort: 20001,
    desktopEnabled: false,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  // Written directly, because the service always stamps the caller as owner.
  const store = new CloudComputerStore(path);
  store.insert(legacy);
  store.close();

  const a = accounts.create("team-a");
  const callerA: Caller = { kind: "account", account: a.account };
  // Handing an unowned computer to the first account created would be a
  // privilege escalation, so it stays invisible to every account.
  assert.deepEqual(service.list(callerA), []);
  assert.equal(service.list(OPERATOR).length, 1);
});

test("the operator marker alone carries full access", () => {
  assert.equal(ownsComputer(OPERATOR, null), true);
  assert.equal(ownsComputer(OPERATOR, "someone"), true);
  const caller: Caller = {
    kind: "account",
    account: { id: "a1", name: "a", status: "active", maxComputers: 1, createdAt: "" }
  };
  assert.equal(ownsComputer(caller, "a1"), true);
  assert.equal(ownsComputer(caller, "a2"), false);
  assert.equal(ownsComputer(caller, null), false, "unowned rows stay with the operator");
});

test("token comparison rejects a prefix and a longer value", () => {
  assert.equal(tokenMatches("secret-token", "secret-token"), true);
  assert.equal(tokenMatches("secret", "secret-token"), false);
  assert.equal(tokenMatches("secret-token-plus", "secret-token"), false);
  assert.equal(tokenMatches("", "secret-token"), false);
});

test("account names and limits are validated", async t => {
  const path = database();
  const accounts = new AccountStore(path);
  t.after(() => { accounts.close(); rmSync(path, { recursive: true, force: true }); });

  assert.throws(() => accounts.create("   "), /1-100 characters/);
  assert.throws(() => accounts.create("x".repeat(101)), /1-100 characters/);
  assert.throws(() => accounts.create("ok", 0), /between 1 and 1000/);
  assert.throws(() => accounts.create("ok", 1001), /between 1 and 1000/);
});
