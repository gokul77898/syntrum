const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs/promises");
const vscode = require("vscode");

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function debug(message) {
  if (process.env.CLOUD_AI_OS_DEBUG_BRIDGE === "1") {
    console.error(`[syntrum:extension] ${message}`);
  }
}

function inside(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function validAgent(agent) {
  return agent && typeof agent === "object" &&
    typeof agent.agentId === "string" && IDENTIFIER.test(agent.agentId) &&
    typeof agent.sessionId === "string" && IDENTIFIER.test(agent.sessionId);
}

function bridgeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeRelativePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    path.isAbsolute(value)
  ) {
    throw bridgeError("INVALID_DOCUMENT_PATH", "Invalid workspace-relative path");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some(segment => segment === "..")) {
    throw bridgeError("INVALID_DOCUMENT_PATH", "Document path escapes the workspace");
  }
  const result = path.normalize(normalized).replaceAll(path.sep, "/").replace(/^\.\//, "");
  if (!result || result === "." || result === ".." || result.startsWith("../")) {
    throw bridgeError("INVALID_DOCUMENT_PATH", "Invalid workspace-relative path");
  }
  return result;
}

async function configuredWorkspaces() {
  const raw = process.env.CLOUD_AI_OS_WORKSPACES;
  if (!raw) {
    throw new Error("CLOUD_AI_OS_WORKSPACES is required");
  }
  const configurations = JSON.parse(raw);
  if (!Array.isArray(configurations) || configurations.length === 0) {
    throw new Error("CLOUD_AI_OS_WORKSPACES must be a nonempty JSON array");
  }

  const folders = vscode.workspace.workspaceFolders || [];
  const folderPaths = await Promise.all(folders.map(async folder => ({
    folder,
    rootPath: folder.uri.scheme === "file" ? await fs.realpath(folder.uri.fsPath) : null
  })));
  const workspaces = [];
  for (const configuration of configurations) {
    if (
      !configuration || typeof configuration.id !== "string" ||
      !IDENTIFIER.test(configuration.id) || typeof configuration.rootPath !== "string"
    ) {
      throw new Error("Invalid workspace bridge configuration");
    }
    const configuredRoot = await fs.realpath(configuration.rootPath);
    if (folderPaths.some(item => item.rootPath === configuredRoot)) {
      workspaces.push({ id: configuration.id, rootPath: configuredRoot });
    }
  }
  debug(`workspace folders: ${JSON.stringify(folderPaths.map(item => item.rootPath))}`);
  debug(`registered workspaces: ${JSON.stringify(workspaces.map(item => item.rootPath))}`);
  return workspaces;
}

class ExtensionBridge {
  constructor(context, socketPath, token, workspaces) {
    this.context = context;
    this.socketPath = socketPath;
    this.token = token;
    this.workspaces = new Map(workspaces.map(item => [item.id, item]));
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.reconnectTimer = null;
    this.writeQueues = new Map();
    this.pendingOrigins = new Map();
    this.eventQueue = [];
    this.flushingEvents = false;
    this.eventProcessing = Promise.resolve();

    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(document => {
        this.captureDocumentEvent("document.opened", document);
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        this.captureDocumentEvent("document.changed", event.document);
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        this.captureDocumentEvent("document.saved", document);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        this.pendingOrigins.delete(document.uri.toString());
        this.captureDocumentEvent("document.closed", document);
      })
    );
  }

  start() {
    this.connect();
  }

  connect() {
    if (this.closed || (this.socket && !this.socket.destroyed)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    debug(`connecting to runtime at ${this.socketPath} (${this.socketPath.length} chars)`);
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.ready = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      debug(`connected; sending hello for ${Array.from(this.workspaces.keys()).join(",")}`);
      socket.write(`${JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: this.token,
        workspaces: Array.from(this.workspaces.values())
      })}\n`, error => {
        if (error) {
          socket.destroy();
        }
      });
    });
    socket.on("data", chunk => {
      if (this.socket !== socket) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            socket.destroy();
            return;
          }
          if (message.type === "hello") {
            this.completeHandshake(socket, message);
          } else if (!this.ready) {
            socket.destroy();
            return;
          } else if (message.type === "request") {
            void this.handleRequest(message);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", error => {
      debug(`socket error: ${error.message}`);
      socket.destroy();
    });
    socket.on("close", () => {
      debug("socket closed");
      if (this.socket === socket) {
        this.socket = null;
        this.ready = false;
        if (!this.closed && !this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, 1_000);
        }
      }
    });
  }

  completeHandshake(socket, message) {
    if (
      this.socket !== socket || this.ready ||
      message.protocolVersion !== PROTOCOL_VERSION ||
      !Array.isArray(message.workspaces)
    ) {
      socket.destroy();
      return;
    }
    this.ready = true;
    debug(`handshake accepted for ${message.workspaces.join(",")}`);
    this.flushEvents();
  }

  send(message) {
    const socket = this.socket;
    if (!this.ready || !socket || socket.destroyed) {
      return;
    }
    socket.write(`${JSON.stringify(message)}\n`, error => {
      if (error) {
        socket.destroy();
      }
    });
  }

  queueEvent(message) {
    this.eventQueue.push(message);
    this.flushEvents();
  }

  flushEvents() {
    const socket = this.socket;
    if (
      this.flushingEvents || !this.ready || !socket || socket.destroyed ||
      this.eventQueue.length === 0
    ) {
      return;
    }

    const message = this.eventQueue[0];
    this.flushingEvents = true;
    socket.write(`${JSON.stringify(message)}\n`, error => {
      this.flushingEvents = false;
      if (!error && this.socket === socket && this.ready && this.eventQueue[0] === message) {
        this.eventQueue.shift();
      }
      if (error) {
        socket.destroy();
      }
      this.flushEvents();
    });
  }

  async handleRequest(request) {
    try {
      if (typeof request.id !== "string" || !validAgent(request.agent)) {
        throw bridgeError("INVALID_REQUEST", "Invalid request identity or identifier");
      }
      const workspace = this.workspaces.get(request.workspaceId);
      if (!workspace) {
        throw bridgeError("UNKNOWN_WORKSPACE", "Workspace is not available in this window");
      }

      let result;
      if (request.operation === "document.list") {
        result = await this.listDocuments(workspace);
      } else if (request.operation === "document.read") {
        result = await this.readDocument(workspace, request.path);
      } else if (request.operation === "document.write") {
        result = await this.writeDocument(
          workspace,
          request.path,
          request.text,
          request.expectedVersion,
          request.agent
        );
      } else {
        throw bridgeError("UNKNOWN_OPERATION", "Unknown bridge operation");
      }
      this.send({ type: "response", id: request.id, result });
    } catch (error) {
      this.send({
        type: "response",
        id: typeof request.id === "string" ? request.id : "invalid",
        error: {
          code: typeof error.code === "string" ? error.code : "EXTENSION_ERROR",
          message: error instanceof Error ? error.message : String(error),
          details: error.details
        }
      });
    }
  }

  async canonicalDocument(workspace, value) {
    const relativePath = normalizeRelativePath(value);
    let canonicalPath;
    try {
      canonicalPath = await fs.realpath(path.resolve(workspace.rootPath, relativePath));
    } catch {
      throw bridgeError("DOCUMENT_NOT_FOUND", `Document '${relativePath}' does not exist`);
    }
    const details = await fs.stat(canonicalPath);
    if (
      canonicalPath === workspace.rootPath ||
      !inside(workspace.rootPath, canonicalPath) ||
      !details.isFile()
    ) {
      throw bridgeError(
        "INVALID_DOCUMENT_PATH",
        "Document must be a file inside the workspace"
      );
    }
    return {
      canonicalPath,
      relativePath: path.relative(workspace.rootPath, canonicalPath).replaceAll(path.sep, "/")
    };
  }

  snapshot(workspace, document, canonicalPath) {
    return {
      workspaceId: workspace.id,
      path: path.relative(workspace.rootPath, canonicalPath).replaceAll(path.sep, "/"),
      text: document.getText(),
      version: document.version,
      languageId: document.languageId,
      dirty: document.isDirty,
      eol: document.eol === vscode.EndOfLine.CRLF ? "crlf" : "lf"
    };
  }

  async openDocument(workspace, value) {
    const { canonicalPath } = await this.canonicalDocument(workspace, value);
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(canonicalPath)
    );
    return { workspace, document, canonicalPath };
  }

  async listDocuments(workspace) {
    const result = [];
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== "file") {
        continue;
      }
      let canonicalPath;
      try {
        canonicalPath = await fs.realpath(document.uri.fsPath);
      } catch {
        continue;
      }
      if (canonicalPath !== workspace.rootPath && inside(workspace.rootPath, canonicalPath)) {
        const snapshot = this.snapshot(workspace, document, canonicalPath);
        delete snapshot.text;
        delete snapshot.eol;
        result.push(snapshot);
      }
    }
    return result;
  }

  async readDocument(workspace, value) {
    const opened = await this.openDocument(workspace, value);
    return this.snapshot(workspace, opened.document, opened.canonicalPath);
  }

  removeOrigin(key, origin) {
    const origins = this.pendingOrigins.get(key) || [];
    const index = origins.indexOf(origin);
    if (index !== -1) {
      origins.splice(index, 1);
    }
    if (origins.length) {
      this.pendingOrigins.set(key, origins);
    } else {
      this.pendingOrigins.delete(key);
    }
  }

  async writeDocument(workspace, value, text, expectedVersion, agent) {
    if (
      typeof text !== "string" || !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      throw bridgeError("INVALID_REQUEST", "Invalid text or expected document version");
    }
    const opened = await this.openDocument(workspace, value);
    const key = opened.document.uri.toString();
    const previous = this.writeQueues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const currentBeforeCheck = this.snapshot(workspace, opened.document, opened.canonicalPath);
      if (opened.document.version !== expectedVersion) {
        throw bridgeError("VERSION_CONFLICT", "Document version conflict", {
          current: currentBeforeCheck
        });
      }

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        opened.document.positionAt(0),
        opened.document.positionAt(opened.document.getText().length)
      );
      edit.replace(opened.document.uri, fullRange, text);
      const origin = { agent };
      const origins = this.pendingOrigins.get(key) || [];
      origins.push(origin);
      this.pendingOrigins.set(key, origins);
      let applied;
      try {
        applied = await vscode.workspace.applyEdit(edit);
      } catch (error) {
        this.removeOrigin(key, origin);
        throw error;
      }
      if (!applied) {
        this.removeOrigin(key, origin);
        throw bridgeError("EDIT_REJECTED", "VS Code rejected the workspace edit");
      }
      return this.snapshot(workspace, opened.document, opened.canonicalPath);
    });
    this.writeQueues.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.writeQueues.get(key) === operation) {
        this.writeQueues.delete(key);
      }
    }
  }

  captureDocumentEvent(eventType, document) {
    const key = document.uri.toString();
    const captured = {
      uri: document.uri,
      version: document.version,
      isDirty: document.isDirty
    };
    let origin = null;
    if (eventType === "document.changed") {
      const origins = this.pendingOrigins.get(key) || [];
      const pending = origins.shift();
      origin = pending ? pending.agent : null;
      if (origins.length) {
        this.pendingOrigins.set(key, origins);
      } else {
        this.pendingOrigins.delete(key);
      }
    }

    this.eventProcessing = this.eventProcessing
      .then(() => this.sendDocumentEvent(eventType, captured, origin))
      .catch(error => {
        console.error(`Cloud AI OS bridge could not queue a document event: ${error.message}`);
      });
  }

  async sendDocumentEvent(eventType, document, origin) {
    if (document.uri.scheme !== "file") {
      return;
    }
    let canonicalPath;
    try {
      canonicalPath = await fs.realpath(document.uri.fsPath);
    } catch {
      canonicalPath = path.resolve(document.uri.fsPath);
    }

    for (const workspace of this.workspaces.values()) {
      if (
        canonicalPath === workspace.rootPath ||
        !inside(workspace.rootPath, canonicalPath)
      ) {
        continue;
      }
      this.queueEvent({
        type: "event",
        eventType,
        workspaceId: workspace.id,
        path: path.relative(workspace.rootPath, canonicalPath).replaceAll(path.sep, "/"),
        version: document.version,
        dirty: document.isDirty,
        origin
      });
    }
  }

  dispose() {
    this.closed = true;
    this.ready = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
    }
  }
}

async function activate(context) {
  const socketPath = process.env.CLOUD_AI_OS_VSCODE_SOCKET;
  const token = process.env.CLOUD_AI_OS_VSCODE_TOKEN;
  debug(`activation socket=${socketPath ?? "<missing>"}; tokenPresent=${Boolean(token)}; workspacesPresent=${Boolean(process.env.CLOUD_AI_OS_WORKSPACES)}`);
  if (!socketPath || !token) {
    console.error("Cloud AI OS bridge requires its Unix socket and auth token environment variables");
    return;
  }
  try {
    const workspaces = await configuredWorkspaces();
    const bridge = new ExtensionBridge(context, socketPath, token, workspaces);
    context.subscriptions.push({ dispose: () => bridge.dispose() });
    bridge.start();
  } catch (error) {
    console.error(`Cloud AI OS bridge activation failed: ${error.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
