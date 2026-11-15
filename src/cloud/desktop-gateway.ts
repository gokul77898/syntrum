import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

// Reaches a guest desktop through the worker without opening a port on it.
//
// `ssh -W host:port` hands back the remote TCP connection on stdin/stdout, so
// this is a byte bridge: the browser's own WebSocket handshake travels to
// websockify untouched. That is why there is no `ws` dependency here and no
// frame re-encoding — the gateway never parses the protocol it carries, and so
// cannot disagree with noVNC about subprotocols or fragmentation.
//
// The target host and port come from the control plane's own view of the
// instance. They are never read from the request, so a browser cannot aim the
// tunnel at an arbitrary address.
const DEFAULT_WS_PATH = "/websockify";
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

export type DesktopTarget = { host: string; port: number };

export type DesktopSshOptions = {
  host: string;
  user: string;
  knownHostsPath?: string;
  identityFile?: string;
};

export type DesktopGatewayOptions = {
  ssh: DesktopSshOptions;
  /** Absolute address of the guest desktop, resolved from the control plane. */
  resolveTarget: (computerId: string) => Promise<DesktopTarget>;
  /** Establishes the caller is an authenticated operator session. */
  authorize: (req: IncomingMessage) => boolean;
  /** Path websockify listens on inside the guest. */
  webSocketPath?: string;
};

function sshArgs(options: DesktopSshOptions, target: DesktopTarget): string[] {
  return [
    "-n",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    ...(options.knownHostsPath
      ? ["-o", `UserKnownHostsFile=${options.knownHostsPath}`]
      : []),
    ...(options.identityFile
      ? ["-i", options.identityFile, "-o", "IdentitiesOnly=yes"]
      : []),
    "-W", `${target.host}:${target.port}`,
    `${options.user}@${options.host}`
  ];
}

// Raw HTTP/1.1 text, because Node has already consumed the original bytes by
// the time a handler runs. rawHeaders preserves the exact ordering and casing,
// which keeps Sec-WebSocket-Key byte-identical to what the browser sent.
// A browser-supplied Host is dropped and replaced with the real upstream, so a
// crafted header cannot misdirect the guest's own routing.
export function buildUpgradeRequest(
  req: IncomingMessage,
  upstreamPath: string,
  host: string
): string {
  const lines = [`${req.method ?? "GET"} ${upstreamPath} HTTP/1.1`];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    if (name.toLowerCase() === "host") continue;
    lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
  }
  return `${lines.join("\r\n")}\r\nHost: ${host}\r\n\r\n`;
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

export class DesktopGateway {
  private readonly path: string;

  constructor(private readonly options: DesktopGatewayOptions) {
    this.path = options.webSocketPath ?? DEFAULT_WS_PATH;
  }

  // Handles the WebSocket upgrade by bridging raw bytes to the guest.
  async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    computerId: string
  ): Promise<void> {
    if (!this.options.authorize(req)) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    let target: DesktopTarget;
    try {
      target = await this.options.resolveTarget(computerId);
    } catch (error) {
      reject(socket, 502, "Desktop unavailable");
      return;
    }

    const child = spawn("ssh", sshArgs(this.options.ssh, target), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let settled = false;
    const fail = (status: number, message: string) => {
      if (settled) return;
      settled = true;
      child.removeAllListeners();
      child.kill("SIGKILL");
      reject(socket, status, message);
    };

    // A tunnel that never comes up must not leave a browser hanging forever.
    const timer = setTimeout(() => fail(504, "Desktop connection timed out"), UPSTREAM_TIMEOUT_MS);
    const done = () => clearTimeout(timer);

    child.on("error", () => fail(502, "Desktop tunnel could not start"));
    child.on("exit", () => {
      done();
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    });

    // The socket is already hijacked, so no HTTP framework will write to it.
    socket.on("error", () => child.kill("SIGKILL"));
    socket.on("close", () => {
      done();
      child.kill("SIGKILL");
    });

    try {
      child.stdin.write(buildUpgradeRequest(req, this.path, `${target.host}:${target.port}`));
      if (head.length > 0) child.stdin.write(head);
    } catch (error) {
      fail(502, "Desktop tunnel write failed");
      return;
    }

    settled = true;
    clearTimeout(timer);
    // Bytes only: a UTF-8 decode here would corrupt binary VNC frames.
    child.stdout.on("data", chunk => socket.write(chunk));
    socket.pipe(child.stdin);
    child.stderr.on("data", () => {
      /* ssh diagnostics are not the browser's to read */
    });
  }

  // Serves noVNC's static assets from the guest's own install, so no third
  // party copy of the client is vendored into this repo.
  async proxyAsset(
    req: IncomingMessage,
    res: ServerResponse,
    computerId: string,
    assetPath: string
  ): Promise<void> {
    if (!this.options.authorize(req)) {
      res.statusCode = 401;
      res.end();
      return;
    }
    // Only a same-site path under the noVNC root; never a URL or a bare path.
    if (!assetPath.startsWith("/") || assetPath.includes("..")) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const target = await this.options.resolveTarget(computerId);
    const upstream = await this.fetchUpstream(target, assetPath, req);
    res.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      // Content-Length is recomputed; hop-by-hop headers must not be forwarded.
      if (["content-length", "transfer-encoding", "connection", "keep-alive"].includes(name)) {
        continue;
      }
      res.setHeader(name, value);
    }
    res.end(upstream.body);
  }

  private fetchUpstream(
    target: DesktopTarget,
    assetPath: string,
    req: IncomingMessage
  ): Promise<{ status: number; headers: [string, string][]; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", sshArgs(this.options.ssh, target), {
        stdio: ["pipe", "pipe", "pipe"]
      });
      const chunks: Buffer[] = [];
      let total = 0;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Desktop asset request timed out"));
      }, UPSTREAM_TIMEOUT_MS);

      child.on("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_HEADER_BYTES + MAX_ASSET_BYTES) {
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        try {
          resolve(parseResponse(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });

      const request =
        `GET ${assetPath} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n` +
        `Accept: ${req.headers.accept ?? "*/*"}\r\nConnection: close\r\n\r\n`;
      child.stdin.write(request);
    });
  }
}

// Minimal parse of a response from the guest's own websockify. The hop is
// trusted interior traffic, and the caller drops hop-by-hop headers, so this
// only needs to find where the headers end.
export function parseResponse(
  raw: Buffer
): { status: number; headers: [string, string][]; body: Buffer } {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) {
    throw new Error("Upstream response had no header terminator");
  }
  const head = raw.subarray(0, separator).toString("utf8");
  const body = raw.subarray(separator + 4);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const status = Number.parseInt(statusLine.split(" ")[1] ?? "", 10);
  if (!Number.isFinite(status)) {
    throw new Error(`Upstream response status was unreadable: ${statusLine}`);
  }
  const headers: [string, string][] = [];
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.push([line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]);
  }
  return { status, headers, body };
}
