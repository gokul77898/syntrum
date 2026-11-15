// Live acceptance for the desktop gateway: prove a browser's WebSocket upgrade
// travels through the gateway and the ssh byte stream to the guest's own
// websockify, and that real RFB bytes come back.
//
// Opt-in and read-only with respect to the guest: it never starts, stops or
// modifies the computer, it only connects to a desktop that is already up.
//
//   SYNTRUM_WORKER_SSH_HOST=... SYNTRUM_WORKER_SSH_USER=... \
//   SYNTRUM_DESKTOP_HOST=10.0.0.5 SYNTRUM_DESKTOP_PORT=20000 \
//   npm run test:live-gateway
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

import { DesktopGateway } from "../cloud/desktop-gateway.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} required`);
  }
  return value;
}

const evidence: Record<string, unknown> = { status: "STARTED" };

async function main(): Promise<void> {
  const host = required("SYNTRUM_DESKTOP_HOST");
  const port = Number(required("SYNTRUM_DESKTOP_PORT"));
  const workerHost = required("SYNTRUM_WORKER_SSH_HOST");
  const workerUser = required("SYNTRUM_WORKER_SSH_USER");

  const gateway = new DesktopGateway({
    ssh: {
      host: workerHost,
      user: workerUser,
      knownHostsPath: process.env.SYNTRUM_WORKER_SSH_KNOWN_HOSTS,
      identityFile: process.env.SYNTRUM_WORKER_SSH_IDENTITY_FILE
    },
    authorize: () => true,
    // The real gateway resolves this from the control plane; the acceptance
    // run takes it from the environment so it does not need a control plane.
    resolveTarget: async () => ({ host, port })
  });

  // A real HTTP server, so the upgrade travels the same path production does
  // rather than calling the handler in isolation.
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    const match = /^\/desktop\/([^/]+)\/websockify$/.exec(
      new URL(req.url ?? "/", "http://localhost").pathname
    );
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    void gateway.handleUpgrade(req, socket, Buffer.from(head), match[1])
      .catch(() => socket.destroy());
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const serverPort = (server.address() as { port: number }).port;
  evidence.gatewayPort = serverPort;

  try {
    const key = randomBytes(16).toString("base64");
    let received = Buffer.alloc(0);
    const socket = connect(serverPort, "127.0.0.1");
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    await new Promise<void>(resolve => socket.on("connect", resolve));

    socket.write(
      `GET /desktop/computer-1/websockify HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${serverPort}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
      `Sec-WebSocket-Protocol: binary\r\n\r\n`
    );

    // Wait for the handshake *and* the first RFB bytes: they arrive in
    // separate segments, so stopping at the first byte of response would
    // report a zero-length frame buffer on a perfectly healthy desktop.
    const deadline = Date.now() + 25_000;
    let headerEnd = -1;
    while (Date.now() < deadline) {
      const text = received.toString("latin1");
      headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd >= 0 && received.length > headerEnd + 4) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const text = received.toString("latin1");
    const expected = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    const accept = (text.match(/sec-websocket-accept:\s*(\S+)/i) ?? [])[1];

    evidence.statusLine = text.split("\r\n")[0] ?? "(no response)";
    evidence.subprotocol = (text.match(/sec-websocket-protocol:\s*(\S+)/i) ?? [])[1] ?? "none";
    evidence.acceptMatchesKey = accept === expected;
    evidence.rfbBytes = headerEnd < 0 ? 0 : received.length - (headerEnd + 4);
    // The RFB banner identifies the guest's real VNC server, which is what
    // distinguishes a live session from a bare protocol upgrade.
    evidence.rfbBanner = headerEnd < 0
      ? undefined
      : received.subarray(headerEnd + 4, headerEnd + 15).toString("latin1").trim();

    if (!text.startsWith("HTTP/1.1 101")) {
      throw new Error(`The gateway did not complete the upgrade: ${evidence.statusLine}`);
    }
    if (accept !== expected) {
      throw new Error("The WebSocket accept token did not match the client key");
    }
    if (evidence.rfbBytes === 0) {
      throw new Error("The upgrade succeeded but no RFB bytes arrived");
    }
    evidence.status = "PASSED";
    socket.destroy();
  } catch (error) {
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    server.close();
  }

  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status !== "PASSED") {
    process.exitCode = 1;
  }
  // The ssh bridge is still attached to the guest, so the process would
  // otherwise linger after the evidence is printed.
  process.exit(evidence.status === "PASSED" ? 0 : 1);
}

await main();
