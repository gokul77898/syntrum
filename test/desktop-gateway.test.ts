import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";

import { DesktopGateway, buildUpgradeRequest, parseResponse } from "../src/cloud/desktop-gateway.js";

test("an upstream response is split into status, headers and body", () => {
  const raw = Buffer.from(
    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello"
  );
  const parsed = parseResponse(raw);
  assert.equal(parsed.status, 200);
  assert.deepEqual(parsed.headers, [
    ["content-type", "text/html"],
    ["content-length", "5"]
  ]);
  assert.equal(parsed.body.toString("utf8"), "hello");
});

test("a response with no header terminator is refused, not guessed at", () => {
  assert.throws(() => parseResponse(Buffer.from("HTTP/1.1 200 OK")), /no header terminator/);
});

test("an unreadable status line is refused", () => {
  assert.throws(
    () => parseResponse(Buffer.from("garbage\r\n\r\n")),
    /status was unreadable/
  );
});

test("a body containing CRLFCRLF is not mistaken for a second response", () => {
  const raw = Buffer.from(
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nfirst\r\n\r\nsecond"
  );
  const parsed = parseResponse(raw);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.toString("utf8"), "first\r\n\r\nsecond");
});

// A header line without a colon (or with an empty name) must be skipped rather
// than producing a bogus header that could confuse the browser.
test("malformed header lines are skipped", () => {
  const raw = Buffer.from("HTTP/1.1 200 OK\r\nnot-a-header\r\n: empty\r\nX: 1\r\n\r\n");
  const parsed = parseResponse(raw);
  assert.deepEqual(parsed.headers, [["x", "1"]]);
});

function fakeSocket() {
  const written: string[] = [];
  const socket = new EventEmitter() as unknown as Socket & { written: string[] };
  (socket as any).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  (socket as any).destroy = () => {};
  (socket as any).pipe = () => {};
  (socket as any).written = written;
  return socket as Socket & { written: string[] };
}

const request = (authorized: boolean): IncomingMessage =>
  ({
    method: "GET",
    rawHeaders: ["Sec-WebSocket-Key", "abc", "Upgrade", "websocket"],
    headers: {}
  }) as unknown as IncomingMessage;

test("an unauthenticated upgrade is refused before any tunnel is opened", async () => {
  let resolved = false;
  const gateway = new DesktopGateway({
    ssh: { host: "worker", user: "u" },
    authorize: () => false,
    resolveTarget: async () => {
      resolved = true;
      return { host: "10.0.0.1", port: 20000 };
    }
  });
  const socket = fakeSocket();
  await gateway.handleUpgrade(request(false), socket, Buffer.alloc(0), "computer-1");
  assert.match(socket.written.join(""), /401 Unauthorized/);
  assert.equal(resolved, false, "an unauthenticated request must not resolve a target");
});

test("a desktop that cannot be resolved is refused, not dialled", async () => {
  const gateway = new DesktopGateway({
    ssh: { host: "worker", user: "u" },
    authorize: () => true,
    resolveTarget: async () => {
      throw new Error("computer is stopped");
    }
  });
  const socket = fakeSocket();
  await gateway.handleUpgrade(request(true), socket, Buffer.alloc(0), "computer-1");
  assert.match(socket.written.join(""), /502 Desktop unavailable/);
});

// The browser's handshake must reach websockify byte-identical: the gateway
// does not speak the protocol, so any rewriting would break the Sec-WebSocket
// key agreement that noVNC depends on.
test("the upgrade request forwards the handshake headers and drops the browser Host", () => {
  const built = buildUpgradeRequest(request(true), "/websockify", "10.0.0.1:20000");
  assert.match(built, /^GET \/websockify HTTP\/1\.1\r\n/);
  assert.match(built, /Sec-WebSocket-Key: abc/);
  assert.match(built, /Upgrade: websocket/);
  assert.match(built, /Host: 10\.0\.0\.1:20000/);
  // Exactly one Host line, and it is the upstream's.
  assert.equal(built.split("Host:").length - 1, 1);
  assert.ok(built.endsWith("\r\n\r\n"), "the header block is terminated");
});

test("a browser-supplied Host cannot redirect the guest request", () => {
  const hostile = {
    method: "GET",
    rawHeaders: ["Host", "evil.example", "Upgrade", "websocket"],
    headers: {}
  } as unknown as IncomingMessage;
  const built = buildUpgradeRequest(hostile, "/websockify", "10.0.0.1:20000");
  assert.equal(built.includes("evil.example"), false);
});
