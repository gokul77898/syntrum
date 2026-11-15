import type { BusErrorPayload } from "./types.js";

export class BusError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BusError";
    this.code = code;
    this.details = details;
  }

  toJSON(): BusErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

export function asBusError(error: unknown): BusError {
  if (error instanceof BusError) {
    return error;
  }

  if (error instanceof Error) {
    return new BusError("INTERNAL_ERROR", error.message);
  }

  return new BusError("INTERNAL_ERROR", "Unknown bus error");
}

export function errorFromPayload(payload: BusErrorPayload): BusError {
  return new BusError(payload.code, payload.message, payload.details);
}
