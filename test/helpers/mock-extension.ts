import { createConnection, type Socket } from "node:net";

import type { DocumentSnapshot } from "../../src/adapters/index.js";

export class MockExtension {
  private socket?: Socket;
  private buffer = "";
  private version = 7;
  private text = "initial text";

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly rootPath: string
  ) {}

  async connect(): Promise<void> {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    const welcomed = new Promise<void>((resolveWelcome, rejectWelcome) => {
      const timer = setTimeout(() => rejectWelcome(new Error("Mock extension handshake timed out")), 1000);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          token: this.token,
          workspaces: [{ id: "main", rootPath: this.rootPath }]
        })}\n`);
      });
      socket.once("error", rejectWelcome);
      socket.on("data", (chunk: string) => {
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline !== -1) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line) {
            const message = JSON.parse(line);
            if (message.type === "hello") {
              clearTimeout(timer);
              resolveWelcome();
            } else if (message.type === "request") {
              this.handleRequest(message);
            }
          }
          newline = this.buffer.indexOf("\n");
        }
      });
    });
    await welcomed;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private snapshot(): DocumentSnapshot {
    return {
      workspaceId: "main",
      path: "note.txt",
      text: this.text,
      version: this.version,
      languageId: "plaintext",
      dirty: false,
      eol: "lf"
    };
  }

  private handleRequest(request: Record<string, any>): void {
    if (request.operation === "document.list") {
      const { text: _text, eol: _eol, ...descriptor } = this.snapshot();
      this.send({ type: "response", id: request.id, result: [descriptor] });
      return;
    }
    if (request.operation === "document.read") {
      this.send({
        type: "event",
        eventType: "document.opened",
        workspaceId: "main",
        path: "note.txt",
        version: this.version,
        dirty: false,
        origin: null
      });
      this.send({ type: "response", id: request.id, result: this.snapshot() });
      return;
    }
    if (request.operation === "document.write") {
      if (request.expectedVersion !== this.version) {
        this.send({
          type: "response",
          id: request.id,
          error: {
            code: "VERSION_CONFLICT",
            message: "Document version conflict",
            details: { current: this.snapshot() }
          }
        });
        return;
      }
      this.text = request.text;
      this.version += 1;
      const snapshot = { ...this.snapshot(), dirty: true };
      this.send({
        type: "event",
        eventType: "document.changed",
        workspaceId: "main",
        path: "note.txt",
        version: this.version,
        dirty: true,
        origin: request.agent
      });
      this.send({ type: "response", id: request.id, result: snapshot });
      return;
    }
    throw new Error("Unexpected operation");
  }

  private send(message: unknown): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }
}
