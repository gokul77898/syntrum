import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../runtime/database.js";
import { CloudError } from "./types.js";

/**
 * Accounts and the computers they own.
 *
 * One operator token authenticated every request before this existed, so a
 * second person would have seen the first person's computers. A caller is now
 * an `Account`, or the operator, who sees everything.
 */

export type Account = {
  id: string;
  name: string;
  status: "active" | "disabled";
  maxComputers: number;
  createdAt: string;
};

/** Who a request is: a real account, or the operator. */
export type Caller =
  | { kind: "operator" }
  | { kind: "account"; account: Account };

export const OPERATOR: Caller = { kind: "operator" };

// The operator column is null for computers made before accounts existed, so
// this is the identity that only the operator matches.
export const NO_OWNER = null;

/** 32 random bytes, hex — enough that hashing without a salt is fine. */
export function newAccountToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AccountStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path);
  }

  create(name: string, maxComputers = 5): { account: Account; token: string } {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      throw new CloudError(400, "INVALID_ACCOUNT_NAME", "Account name must be 1-100 characters");
    }
    if (!Number.isSafeInteger(maxComputers) || maxComputers < 1 || maxComputers > 1000) {
      throw new CloudError(400, "INVALID_ACCOUNT_LIMIT", "maxComputers must be between 1 and 1000");
    }
    const token = newAccountToken();
    const account: Account = {
      id: randomUUID(),
      name: trimmed,
      status: "active",
      maxComputers,
      createdAt: new Date().toISOString()
    };
    this.database.prepare(`
      INSERT INTO accounts (id, name, token_hash, status, max_computers, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      account.id,
      account.name,
      hashToken(token),
      account.status,
      account.maxComputers,
      account.createdAt
    );
    return { account, token };
  }

  /**
   * Resolves a bearer token to its account, or undefined when it matches none.
   * The lookup is by hash, so the token itself is never stored or compared.
   */
  findByToken(token: string): Account | undefined {
    const row = this.database.prepare(
      "SELECT * FROM accounts WHERE token_hash = ?"
    ).get(hashToken(token)) as Record<string, unknown> | undefined;
    // The hash comparison above is a database index lookup on a SHA-256, so
    // there is nothing to time-attack: an attacker cannot steer the outcome.
    return row ? this.fromRow(row) : undefined;
  }

  get(id: string): Account {
    const row = this.database.prepare(
      "SELECT * FROM accounts WHERE id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new CloudError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    return this.fromRow(row);
  }

  list(): Account[] {
    const rows = this.database.prepare(
      "SELECT * FROM accounts ORDER BY created_at ASC, id ASC"
    ).all() as Record<string, unknown>[];
    return rows.map(row => this.fromRow(row));
  }

  /** Rotates the token. The old one stops working immediately. */
  rotateToken(id: string): string {
    this.get(id);
    const token = newAccountToken();
    this.database.prepare(
      "UPDATE accounts SET token_hash = ? WHERE id = ?"
    ).run(hashToken(token), id);
    return token;
  }

  setStatus(id: string, status: Account["status"]): Account {
    this.get(id);
    this.database.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id);
    return this.get(id);
  }

  countComputers(accountId: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS total FROM cloud_computers WHERE owner_id = ? AND status <> 'deleted'"
    ).get(accountId) as { total: number };
    return row.total;
  }

  close(): void {
    this.database.close();
  }

  private fromRow(row: Record<string, unknown>): Account {
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as Account["status"],
      maxComputers: row.max_computers as number,
      createdAt: row.created_at as string
    };
  }
}

/**
 * Constant-time bearer comparison, for the operator token which is configured
 * rather than generated and so could be short.
 */
export function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Whether this caller may see or act on a computer with this owner.
 *
 * Fails closed: a computer with no owner is visible only to the operator. The
 * alternative would hand every pre-existing computer to the first account
 * created.
 */
export function ownsComputer(caller: Caller, ownerId: string | null): boolean {
  if (caller.kind === "operator") return true;
  return ownerId === caller.account.id;
}

export function bearerToken(req: { headers: { authorization?: string } }): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}
