import { TextDecoder } from "node:util";

import { BusError } from "./errors.js";
import { BUS_PROTOCOL_VERSION } from "./types.js";

export type WireError = {
  version: typeof BUS_PROTOCOL_VERSION;
  type: "error";
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

export function encodeFrame(message: unknown, maxFrameBytes: number): Buffer {
  let json: string | undefined;

  try {
    json = JSON.stringify(message);
  } catch {
    throw new BusError("INVALID_JSON", "Message is not JSON serializable");
  }

  if (json === undefined) {
    throw new BusError("INVALID_JSON", "Message must be JSON serializable");
  }

  const frame = Buffer.from(`${json}\n`, "utf8");
  if (frame.byteLength - 1 > maxFrameBytes) {
    throw new BusError(
      "FRAME_TOO_LARGE",
      `Frame exceeds the ${maxFrameBytes}-byte limit`,
      { maxFrameBytes }
    );
  }

  return frame;
}

export function parseFrame(frame: Buffer): Record<string, unknown> {
  const content = frame.at(-1) === 13 ? frame.subarray(0, -1) : frame;
  if (content.byteLength === 0) {
    throw new BusError("INVALID_FRAME", "Empty frames are not allowed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(content));
  } catch {
    throw new BusError("INVALID_JSON", "Frame must contain valid UTF-8 JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BusError("INVALID_FRAME", "Frame must contain a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(readonly maxFrameBytes: number) {}

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    this.buffered = this.buffered.byteLength === 0
      ? chunk
      : Buffer.concat([this.buffered, chunk]);

    let newlineIndex = this.buffered.indexOf(10);
    while (newlineIndex !== -1) {
      if (newlineIndex > this.maxFrameBytes) {
        throw new BusError(
          "FRAME_TOO_LARGE",
          `Frame exceeds the ${this.maxFrameBytes}-byte limit`,
          { maxFrameBytes: this.maxFrameBytes }
        );
      }

      const frame = this.buffered.subarray(0, newlineIndex);
      this.buffered = this.buffered.subarray(newlineIndex + 1);
      onFrame(frame);
      newlineIndex = this.buffered.indexOf(10);
    }

    if (this.buffered.byteLength > this.maxFrameBytes) {
      throw new BusError(
        "FRAME_TOO_LARGE",
        `Frame exceeds the ${this.maxFrameBytes}-byte limit`,
        { maxFrameBytes: this.maxFrameBytes }
      );
    }
  }
}

export function assertProtocolVersion(message: Record<string, unknown>): void {
  if (message.version !== BUS_PROTOCOL_VERSION) {
    throw new BusError(
      "VERSION_MISMATCH",
      `Protocol version must be ${BUS_PROTOCOL_VERSION}`,
      { supportedVersion: BUS_PROTOCOL_VERSION }
    );
  }
}
