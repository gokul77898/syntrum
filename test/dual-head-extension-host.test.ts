import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  AdapterEvent,
  AgentIdentity,
  DocumentConflictError,
  VSCodeAdapter
} from "../src/adapters/index.js";

const enabled = process.env.CLOUD_AI_OS_LIVE_VSCODE_TEST === "1";
const nodeRequire = createRequire(import.meta.url);
const agent: AgentIdentity = { agentId: "unit-agent", sessionId: "unit-session" };
const token = "unit-test-token-with-at-least-16-characters";

interface Disposable {
  dispose(): void;
}

interface ExtensionModule {
  activate(context: { subscriptions: Disposable[] }): Promise<void>;
}

interface FakeUri {
  scheme: string;
  fsPath: string;
  toString(): string;
}

function fileUri(fsPath: string): FakeUri {
  return { scheme: "file", fsPath, toString: () => `file://${fsPath}` };
}

class FakeDocument {
  readonly uri: FakeUri;
  readonly languageId = "plaintext";
  readonly eol = 1;
  version = 7;
  isDirty = false;

  constructor(readonly fsPath: string, private text = "initial text") {
    this.uri = fileUri(fsPath);
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  positionAt(offset: number): number {
    return offset;
  }
}

class FakeRange {
  constructor(readonly start: number, readonly end: number) {}
}

class FakeWorkspaceEdit {
  readonly replacements: { uri: FakeUri; range: FakeRange; text: string }[] = [];

  replace(uri: FakeUri, range: FakeRange, text: string): void {
    this.replacements.push({ uri, range, text });
  }
}

class FakeVSCode {
  readonly document: FakeDocument;
  readonly context = { subscriptions: [] as Disposable[] };
  readonly EndOfLine = { LF: 1, CRLF: 2 };
  readonly Uri = { file: fileUri };
  readonly WorkspaceEdit = FakeWorkspaceEdit;
  readonly Range = FakeRange;
  readonly opened: FakeDocument[] = [];
  readonly saved: FakeDocument[] = [];
  readonly closed: FakeDocument[] = [];
  readonly changes: FakeDocument[] = [];
  focusOperations = 0;
  applyEditHandler: (edit: FakeWorkspaceEdit) => Promise<boolean>;
  readonly workspace: Record<string, unknown>;
  readonly window = {
    showTextDocument: async () => {
      this.focusOperations += 1;
      return this.document;
    }
  };

  constructor(rootPath: string, documentPath: string) {
    this.document = new FakeDocument(documentPath);
    this.applyEditHandler = async edit => {
      this.applyReplacement(edit);
      return true;
    };
    this.workspace = {
      workspaceFolders: [{ uri: fileUri(rootPath) }],
      textDocuments: [this.document],
      onDidOpenTextDocument: (listener: (document: FakeDocument) => void) =>
        this.subscribe(this.opened, listener),
      onDidChangeTextDocument: (
        listener: (event: { document: FakeDocument }) => void
      ) => this.subscribe(this.changes, listener),
      onDidSaveTextDocument: (listener: (document: FakeDocument) => void) =>
        this.subscribe(this.saved, listener),
      onDidCloseTextDocument: (listener: (document: FakeDocument) => void) =>
        this.subscribe(this.closed, listener),
      openTextDocument: async () => this.document,
      applyEdit: (edit: FakeWorkspaceEdit) => this.applyEditHandler(edit)
    };
  }

  emitChange(text: string): void {
    this.document.setText(text);
    this.document.version += 1;
    this.document.isDirty = true;
    for (const listener of [...this.changes]) {
      (listener as unknown as (event: { document: FakeDocument }) => void)({
        document: this.document
      });
    }
  }

  applyReplacement(edit: FakeWorkspaceEdit): void {
    assert.equal(edit.replacements.length, 1);
    this.emitChange(edit.replacements[0].text);
  }

  dispose(): void {
    for (const subscription of [...this.context.subscriptions].reverse()) {
      subscription.dispose();
    }
  }

  private subscribe(
    listeners: FakeDocument[],
    listener: (document: FakeDocument) => void
  ): Disposable {
    const registration = listener as unknown as FakeDocument;
    listeners.push(registration);
    return { dispose: () => {
      const index = listeners.indexOf(registration);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    } };
  }
}

interface DeferredRealpath {
  resolve(path: string): void;
}

interface RealpathController {
  hold: boolean;
  deferred: DeferredRealpath[];
}

async function loadExtension(
  vscode: FakeVSCode,
  realpathController?: RealpathController
): Promise<ExtensionModule> {
  const filename = fileURLToPath(new URL(
    "../adapters/vscode-extension/extension.js",
    import.meta.url
  ));
  const source = await readFile(filename, "utf8");
  const filesystem = nodeRequire("node:fs/promises") as typeof import("node:fs/promises");
  const filesystemDouble = realpathController
    ? {
        ...filesystem,
        realpath: async (value: string) => {
          if (realpathController.hold && value === vscode.document.fsPath) {
            return new Promise<string>(resolve => {
              realpathController.deferred.push({ resolve });
            });
          }
          return filesystem.realpath(value);
        }
      }
    : filesystem;
  const module = { exports: {} as ExtensionModule };
  const wrapper = runInNewContext(
    `(function(require, module, exports) {${source}\n})`,
    { Buffer, console, process, setTimeout, clearTimeout }
  ) as (
    require: (id: string) => unknown,
    module: { exports: ExtensionModule },
    exports: ExtensionModule
  ) => void;
  wrapper(
    (id: string) => {
      if (id === "vscode") {
        return vscode;
      }
      if (id === "node:fs/promises") {
        return filesystemDouble;
      }
      return nodeRequire(id);
    },
    module,
    module.exports
  );
  return module.exports;
}

function setEnvironment(rootPath: string, socketPath: string): () => void {
  const previous = {
    workspaces: process.env.CLOUD_AI_OS_WORKSPACES,
    socket: process.env.CLOUD_AI_OS_VSCODE_SOCKET,
    token: process.env.CLOUD_AI_OS_VSCODE_TOKEN
  };
  process.env.CLOUD_AI_OS_WORKSPACES = JSON.stringify([{ id: "main", rootPath }]);
  process.env.CLOUD_AI_OS_VSCODE_SOCKET = socketPath;
  process.env.CLOUD_AI_OS_VSCODE_TOKEN = token;
  return () => {
    for (const [key, value] of [
      ["CLOUD_AI_OS_WORKSPACES", previous.workspaces],
      ["CLOUD_AI_OS_VSCODE_SOCKET", previous.socket],
      ["CLOUD_AI_OS_VSCODE_TOKEN", previous.token]
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function fixture(t: test.TestContext): Promise<{
  rootPath: string;
  documentPath: string;
  vscode: FakeVSCode;
}> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloud-ai-os-extension-unit-"));
  const rootPath = join(temporaryDirectory, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(rootPath));
  const documentPath = join(rootPath, "note.txt");
  await writeFile(documentPath, "initial text");
  const canonicalRoot = await realpath(rootPath);
  const canonicalDocument = await realpath(documentPath);
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  return {
    rootPath: canonicalRoot,
    documentPath: canonicalDocument,
    vscode: new FakeVSCode(canonicalRoot, canonicalDocument)
  };
}

async function realExtensionSetup(
  t: test.TestContext,
  realpathController?: RealpathController
): Promise<{
  adapter: VSCodeAdapter;
  document: Awaited<ReturnType<VSCodeAdapter["readDocument"]>>;
  vscode: FakeVSCode;
}> {
  const { rootPath, vscode } = await fixture(t);
  const adapter = new VSCodeAdapter({
    workspaces: [{ id: "main", rootPath }],
    socketPath: join(rootPath, "adapter.sock"),
    authToken: token,
    requestTimeoutMs: 2_000
  });
  await adapter.start();
  const restoreEnvironment = setEnvironment(rootPath, adapter.connectionInfo.socketPath);
  const extension = await loadExtension(vscode, realpathController);
  await extension.activate(vscode.context);
  t.after(async () => {
    vscode.dispose();
    restoreEnvironment();
    await adapter.close();
  });
  await adapter.waitForWorkspace("main", 2_000);
  const document = await adapter.readDocument(agent, "main", "note.txt");
  return { adapter, document, vscode };
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

function nextAdapterEvent(adapter: VSCodeAdapter): Promise<AdapterEvent> {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      unsubscribe();
      rejectEvent(new Error("Timed out waiting for adapter event"));
    }, 2_000);
    const unsubscribe = adapter.onEvent(event => {
      clearTimeout(timer);
      unsubscribe();
      resolveEvent(event);
    });
  });
}

class ProtocolPeer {
  readonly server: Server;
  readonly messages: Record<string, any>[] = [];
  readonly sockets = new Set<Socket>();
  autoHello = false;
  helloCount = 0;

  constructor(private readonly socketPath: string) {
    this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) {
            const message = JSON.parse(line);
            this.messages.push(message);
            if (message.type === "hello") {
              this.helloCount += 1;
              if (this.autoHello) {
                this.respondHello(socket);
              }
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(this.socketPath, () => resolveListen());
    });
  }

  respondHello(socket = this.sockets.values().next().value): void {
    assert.ok(socket);
    socket.write(`${JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      workspaces: ["main"]
    })}\n`);
  }

  events(): Record<string, any>[] {
    return this.messages.filter(message => message.type === "event");
  }

  disconnect(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  async close(): Promise<void> {
    this.disconnect();
    if (this.server.listening) {
      await new Promise<void>(resolveClose => this.server.close(() => resolveClose()));
    }
  }
}

test("unit (mock VS Code API, real bridge protocol): events wait for handshake and survive disconnect", async t => {
  const { rootPath, vscode } = await fixture(t);
  const socketPath = join(rootPath, "adapter.sock");
  const peer = new ProtocolPeer(socketPath);
  await peer.listen();
  const restoreEnvironment = setEnvironment(rootPath, socketPath);
  const extension = await loadExtension(vscode);
  await extension.activate(vscode.context);
  t.after(async () => {
    vscode.dispose();
    restoreEnvironment();
    await peer.close();
  });

  await waitUntil(() => peer.helloCount === 1, "the extension handshake");
  vscode.emitChange("before handshake completed");
  await new Promise(resolveWait => setTimeout(resolveWait, 75));
  assert.equal(peer.events().length, 0);

  peer.respondHello();
  await waitUntil(() => peer.events().length === 1, "the post-handshake event");
  assert.equal(peer.events()[0].version, 8);
  assert.equal(peer.events()[0].origin, null);

  peer.disconnect();
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  vscode.emitChange("while disconnected");
  peer.autoHello = true;
  await waitUntil(
    () => peer.helloCount >= 2 && peer.events().length >= 2,
    "reconnect and the queued offline event",
    5_000
  );
  assert.deepEqual(peer.events().map(event => event.version), [8, 9]);
  assert.equal(peer.events()[1].origin, null);
});

test("unit (mock VS Code API, real bridge protocol): delayed events retain agent and human origins", async t => {
  const controller: RealpathController = { hold: false, deferred: [] };
  const { adapter, document, vscode } = await realExtensionSetup(t, controller);
  const events: AdapterEvent[] = [];
  const unsubscribe = adapter.onEvent(event => events.push(event));
  t.after(() => unsubscribe());
  const canonicalDocument = await realpath(vscode.document.fsPath);

  vscode.applyEditHandler = async edit => {
    controller.hold = true;
    vscode.applyReplacement(edit);
    vscode.emitChange("human edit");
    return true;
  };
  const write = adapter.writeDocument(agent, "main", "note.txt", "agent edit", {
    expectedVersion: document.version
  });
  await waitUntil(() => controller.deferred.length >= 1, "the delayed document event");
  controller.hold = false;
  if (controller.deferred.length >= 2) {
    controller.deferred[1].resolve(canonicalDocument);
    await new Promise(resolveWait => setTimeout(resolveWait, 0));
  }
  controller.deferred[0].resolve(canonicalDocument);
  await write;
  await waitUntil(() => events.length >= 2, "agent and human change events");

  assert.deepEqual(events.map(event => event.version), [8, 9]);
  assert.deepEqual(events.map(event => event.origin), [agent, null]);
  assert.equal(vscode.focusOperations, 0);
});

test("unit (mock VS Code API, real bridge protocol): rejected edits leave no stale origin or focus change", async t => {
  const { adapter, document, vscode } = await realExtensionSetup(t);
  vscode.applyEditHandler = async () => false;
  await assert.rejects(
    adapter.writeDocument(agent, "main", "note.txt", "rejected edit", {
      expectedVersion: document.version
    }),
    { code: "EDIT_REJECTED" }
  );

  const changed = nextAdapterEvent(adapter);
  vscode.emitChange("human after rejection");
  const event = await changed;
  assert.equal(event.origin, null);
  assert.equal(event.version, 8);
  assert.equal(vscode.focusOperations, 0);
});

test(
  "live VS Code extension host reads a document and rejects a stale version",
  { skip: enabled ? false : "Requires a running VS Code extension host; see live-test environment requirements" },
  async t => {
    const rootPath = process.env.CLOUD_AI_OS_TEST_WORKSPACE;
    const documentPath = process.env.CLOUD_AI_OS_TEST_DOCUMENT ?? "note.txt";
    const socketPath = process.env.CLOUD_AI_OS_VSCODE_SOCKET;
    const authToken = process.env.CLOUD_AI_OS_VSCODE_TOKEN;
    if (!rootPath || !socketPath || !authToken) {
      throw new Error(
        "Live tests require CLOUD_AI_OS_TEST_WORKSPACE, CLOUD_AI_OS_VSCODE_SOCKET, and CLOUD_AI_OS_VSCODE_TOKEN"
      );
    }

    const adapter = new VSCodeAdapter({
      workspaces: [{ id: "main", rootPath }],
      socketPath,
      authToken,
      requestTimeoutMs: 10_000
    });
    await adapter.start();
    t.after(() => adapter.close());

    await adapter.waitForWorkspace("main", 30_000);
    const liveAgent = { agentId: "live-test", sessionId: "vscode-host" };
    const workspaces = await adapter.listWorkspaces(liveAgent);
    assert.equal(workspaces[0].connected, true);
    const document = await adapter.readDocument(liveAgent, "main", documentPath);
    assert.equal(document.path, documentPath);
    assert.ok(document.version >= 1);

    await assert.rejects(
      adapter.writeDocument(liveAgent, "main", documentPath, document.text, {
        expectedVersion: document.version + 1000
      }),
      (error: unknown) => {
        assert.ok(error instanceof DocumentConflictError);
        assert.equal(error.current.version, document.version);
        return true;
      }
    );
  }
);
