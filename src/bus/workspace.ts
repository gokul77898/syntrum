import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32
} from "node:path";

import { BusError } from "./errors.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  type WorkspaceEncoding,
  type WorkspaceEntry,
  type WorkspaceListResult,
  type WorkspaceReadResult,
  type WorkspaceWriteResult
} from "./types.js";

export type WorkspaceStoreOptions = {
  maxFileBytes?: number;
  maxListEntries?: number;
};

export type RegisterWorkspaceOptions = {
  create?: boolean;
};

type ResolvedPath = {
  root: string;
  absolutePath: string;
  relativePath: string;
};

type ReadFile = {
  content: Buffer;
  size: number;
  version: string;
  modifiedAt: string;
};

const DEFAULT_MAX_LIST_ENTRIES = 1000;
const READ_CHUNK_BYTES = 64 * 1024;

export function validateSessionId(sessionId: unknown): string {
  if (
    typeof sessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)
  ) {
    throw new BusError("INVALID_SESSION_ID", "Invalid session ID");
  }

  return sessionId;
}

function versionOf(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function normalizeFsError(error: unknown): BusError {
  if (error instanceof BusError) {
    return error;
  }

  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";

  switch (code) {
    case "ENOENT":
      return new BusError("NOT_FOUND", "Workspace path does not exist");
    case "EACCES":
    case "EPERM":
      return new BusError("ACCESS_DENIED", "Workspace path is not accessible");
    case "ENOTDIR":
      return new BusError("NOT_A_DIRECTORY", "Expected a directory");
    case "EISDIR":
      return new BusError("NOT_A_FILE", "Expected a regular file");
    case "ELOOP":
      return new BusError("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    default:
      return new BusError("WORKSPACE_ERROR", "Workspace operation failed");
  }
}

export class WorkspaceStore {
  private readonly roots = new Map<string, string>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  readonly maxFileBytes: number;
  readonly maxListEntries: number;

  constructor(options: WorkspaceStoreOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;

    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 0) {
      throw new TypeError("maxFileBytes must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.maxListEntries) || this.maxListEntries < 1) {
      throw new TypeError("maxListEntries must be a positive safe integer");
    }
  }

  async registerSession(
    sessionId: string,
    workspaceRoot: string,
    options: RegisterWorkspaceOptions = {}
  ): Promise<string> {
    validateSessionId(sessionId);
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      throw new TypeError("workspaceRoot must be a non-empty string");
    }

    try {
      const configuredRoot = resolve(workspaceRoot);
      if (options.create === true) {
        await mkdir(configuredRoot, { recursive: true });
      }

      const canonicalRoot = await realpath(configuredRoot);
      const rootStat = await lstat(canonicalRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new BusError(
          "INVALID_WORKSPACE_ROOT",
          "Workspace root must be a real directory"
        );
      }

      this.roots.set(sessionId, canonicalRoot);
      return canonicalRoot;
    } catch (error) {
      throw normalizeFsError(error);
    }
  }

  unregisterSession(sessionId: string): boolean {
    return this.roots.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.roots.has(sessionId);
  }

  workspaceRoot(sessionId: string): string | undefined {
    return this.roots.get(sessionId);
  }

  async read(
    sessionId: string,
    requestedPath: string,
    encoding: WorkspaceEncoding = "utf8"
  ): Promise<WorkspaceReadResult> {
    try {
      if (encoding !== "utf8" && encoding !== "base64") {
        throw new BusError("INVALID_ENCODING", "Encoding must be utf8 or base64");
      }

      const target = this.resolvePath(sessionId, requestedPath, false);
      await this.validateExistingPath(target);
      const result = await this.readAbsolute(target.absolutePath);

      return {
        sessionId,
        path: target.relativePath,
        encoding,
        content: result.content.toString(encoding),
        size: result.size,
        version: result.version,
        modifiedAt: result.modifiedAt
      };
    } catch (error) {
      throw normalizeFsError(error);
    }
  }

  async list(
    sessionId: string,
    requestedPath = "."
  ): Promise<WorkspaceListResult> {
    try {
      const target = this.resolvePath(sessionId, requestedPath, true);
      await this.validateExistingPath(target);
      const targetStat = await lstat(target.absolutePath);
      if (!targetStat.isDirectory()) {
        throw new BusError("NOT_A_DIRECTORY", "Expected a directory");
      }

      const children = await readdir(target.absolutePath, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      const entries: WorkspaceEntry[] = [];

      for (const child of children.slice(0, this.maxListEntries)) {
        const childPath = join(target.absolutePath, child.name);
        try {
          const childStat = await lstat(childPath);
          const type = childStat.isSymbolicLink()
            ? "symlink"
            : childStat.isFile()
              ? "file"
              : childStat.isDirectory()
                ? "directory"
                : "other";

          entries.push({
            name: child.name,
            path: target.relativePath === "."
              ? child.name
              : `${target.relativePath}/${child.name}`,
            type,
            ...(type === "file" || type === "symlink"
              ? { size: childStat.size }
              : {}),
            modifiedAt: childStat.mtime.toISOString()
          });
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      }

      return {
        sessionId,
        path: target.relativePath,
        entries,
        truncated: children.length > this.maxListEntries
      };
    } catch (error) {
      throw normalizeFsError(error);
    }
  }

  async write(
    sessionId: string,
    requestedPath: string,
    content: string,
    encoding: WorkspaceEncoding = "utf8",
    expectedVersion?: string | null
  ): Promise<WorkspaceWriteResult> {
    try {
      if (encoding !== "utf8" && encoding !== "base64") {
        throw new BusError("INVALID_ENCODING", "Encoding must be utf8 or base64");
      }
      if (typeof content !== "string") {
        throw new BusError("INVALID_CONTENT", "File content must be a string");
      }
      if (
        expectedVersion !== undefined &&
        expectedVersion !== null &&
        typeof expectedVersion !== "string"
      ) {
        throw new BusError(
          "INVALID_VERSION",
          "expectedVersion must be a string, null, or omitted"
        );
      }

      const bytes = this.decodeContent(content, encoding);
      if (bytes.byteLength > this.maxFileBytes) {
        throw new BusError(
          "FILE_TOO_LARGE",
          `File exceeds the ${this.maxFileBytes}-byte limit`,
          { maxFileBytes: this.maxFileBytes }
        );
      }

      const target = this.resolvePath(sessionId, requestedPath, false);
      const queueKey = `${target.root}\0${target.relativePath}`;
      return await this.serializeWrite(queueKey, async () => {
        await this.validateWritablePath(target);
        const current = await this.currentFile(target.absolutePath);
        this.checkExpectedVersion(expectedVersion, current);

        const temporaryPath = join(
          dirname(target.absolutePath),
          `.${basename(target.absolutePath)}.bus-${randomUUID()}.tmp`
        );
        let handle: FileHandle | undefined;

        try {
          handle = await open(
            temporaryPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600
          );
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(temporaryPath, target.absolutePath);
          const writtenStat = await lstat(target.absolutePath);

          return {
            sessionId,
            path: target.relativePath,
            size: bytes.byteLength,
            version: versionOf(bytes),
            modifiedAt: writtenStat.mtime.toISOString()
          };
        } finally {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
          }
          await unlink(temporaryPath).catch(() => undefined);
        }
      });
    } catch (error) {
      throw normalizeFsError(error);
    }
  }

  private decodeContent(content: string, encoding: WorkspaceEncoding): Buffer {
    if (encoding === "utf8") {
      return Buffer.from(content, "utf8");
    }

    if (
      content.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
    ) {
      throw new BusError("INVALID_BASE64", "Content must be canonical base64");
    }

    const decoded = Buffer.from(content, "base64");
    if (decoded.toString("base64") !== content) {
      throw new BusError("INVALID_BASE64", "Content must be canonical base64");
    }
    return decoded;
  }

  private resolvePath(
    sessionId: string,
    requestedPath: string,
    allowRoot: boolean
  ): ResolvedPath {
    validateSessionId(sessionId);
    const root = this.roots.get(sessionId);
    if (root === undefined) {
      throw new BusError("SESSION_NOT_FOUND", "Session workspace is not registered");
    }
    if (
      typeof requestedPath !== "string" ||
      requestedPath.length === 0 ||
      Buffer.byteLength(requestedPath, "utf8") > 4096 ||
      requestedPath.includes("\0") ||
      requestedPath.includes("\\") ||
      isAbsolute(requestedPath) ||
      win32.isAbsolute(requestedPath)
    ) {
      throw new BusError("INVALID_PATH", "Path must be a relative workspace path");
    }

    if (requestedPath === ".") {
      if (!allowRoot) {
        throw new BusError("INVALID_PATH", "A file path is required");
      }
      return { root, absolutePath: root, relativePath: "." };
    }

    const segments = requestedPath.split("/");
    if (segments.some(segment =>
      segment.length === 0 || segment === "." || segment === ".."
    )) {
      throw new BusError(
        "INVALID_PATH",
        "Path contains an empty, current, or parent segment"
      );
    }

    const absolutePath = resolve(root, ...segments);
    if (!isContained(root, absolutePath)) {
      throw new BusError("INVALID_PATH", "Path escapes the session workspace");
    }

    return { root, absolutePath, relativePath: segments.join("/") };
  }

  private async validateExistingPath(target: ResolvedPath): Promise<void> {
    await this.validateRoot(target.root);
    await this.validatePathComponents(target, true);

    const canonicalPath = await realpath(target.absolutePath);
    if (!isContained(target.root, canonicalPath)) {
      throw new BusError("INVALID_PATH", "Path escapes the session workspace");
    }
  }

  private async validateWritablePath(target: ResolvedPath): Promise<void> {
    await this.validateRoot(target.root);
    await this.validatePathComponents(target, false);

    const canonicalParent = await realpath(dirname(target.absolutePath));
    if (!isContained(target.root, canonicalParent)) {
      throw new BusError("INVALID_PATH", "Path escapes the session workspace");
    }

    try {
      const targetStat = await lstat(target.absolutePath);
      if (targetStat.isSymbolicLink()) {
        throw new BusError(
          "SYMLINK_NOT_ALLOWED",
          "Symbolic links are not allowed"
        );
      }
      if (!targetStat.isFile()) {
        throw new BusError("NOT_A_FILE", "Expected a regular file");
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  private async validateRoot(root: string): Promise<void> {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new BusError(
        "INVALID_WORKSPACE_ROOT",
        "Workspace root must be a real directory"
      );
    }
  }

  private async validatePathComponents(
    target: ResolvedPath,
    includeLeaf: boolean
  ): Promise<void> {
    const pathFromRoot = relative(target.root, target.absolutePath);
    const segments = pathFromRoot === "" ? [] : pathFromRoot.split(/[\\/]/);
    const count = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
    let current = target.root;

    for (let index = 0; index < count; index += 1) {
      current = join(current, segments[index]);
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) {
        throw new BusError(
          "SYMLINK_NOT_ALLOWED",
          "Symbolic links are not allowed"
        );
      }
      if (index < segments.length - 1 && !currentStat.isDirectory()) {
        throw new BusError("NOT_A_DIRECTORY", "Expected a directory");
      }
    }
  }

  private async readAbsolute(absolutePath: string): Promise<ReadFile> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        throw new BusError("NOT_A_FILE", "Expected a regular file");
      }
      if (fileStat.size > this.maxFileBytes) {
        throw new BusError(
          "FILE_TOO_LARGE",
          `File exceeds the ${this.maxFileBytes}-byte limit`,
          { maxFileBytes: this.maxFileBytes }
        );
      }

      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(
          Math.min(READ_CHUNK_BYTES, this.maxFileBytes - total + 1)
        );
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (bytesRead === 0) {
          break;
        }
        total += bytesRead;
        if (total > this.maxFileBytes) {
          throw new BusError(
            "FILE_TOO_LARGE",
            `File exceeds the ${this.maxFileBytes}-byte limit`,
            { maxFileBytes: this.maxFileBytes }
          );
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }

      const content = Buffer.concat(chunks, total);
      const finalStat = await handle.stat();
      return {
        content,
        size: content.byteLength,
        version: versionOf(content),
        modifiedAt: finalStat.mtime.toISOString()
      };
    } finally {
      if (handle !== undefined) {
        await handle.close();
      }
    }
  }

  private async currentFile(absolutePath: string): Promise<ReadFile | undefined> {
    try {
      return await this.readAbsolute(absolutePath);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private checkExpectedVersion(
    expectedVersion: string | null | undefined,
    current: ReadFile | undefined
  ): void {
    if (expectedVersion === undefined) {
      return;
    }

    const matches = expectedVersion === null
      ? current === undefined
      : current?.version === expectedVersion;
    if (!matches) {
      throw new BusError(
        "VERSION_CONFLICT",
        "Workspace file version does not match expectedVersion",
        { actualVersion: current?.version ?? null }
      );
    }
  }

  private async serializeWrite<T>(
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const settled = running.then(() => undefined, () => undefined);
    this.writeQueues.set(key, settled);

    try {
      return await running;
    } finally {
      if (this.writeQueues.get(key) === settled) {
        this.writeQueues.delete(key);
      }
    }
  }
}
