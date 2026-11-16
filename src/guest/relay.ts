import { createConnection } from "node:net";

/**
 * Copies stdin/stdout to the agent bus socket inside the guest.
 *
 * This exists because a restricted Incus project forbids the proxy device that
 * would otherwise publish the socket on the worker, so the host bridges to the
 * socket by running this inside the container. It is a separate file rather
 * than an inline `node -e` string because the remote shell mangles the quoting
 * of a multi-statement one-liner.
 *
 * It carries no authority of its own: the bus still demands a valid agent
 * grant in the handshake, and the process runs as whatever user incus exec
 * uses.
 */
const socketPath = process.env.SYNTRUM_BUS_SOCKET ?? "/run/syntrum/bus.sock";

const socket = createConnection(socketPath);
const fail = (error: Error) => {
  process.stderr.write(`syntrum-relay: ${error.message}\n`);
  process.exit(1);
};

socket.on("error", fail);
process.stdin.on("error", fail);
process.stdout.on("error", () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
