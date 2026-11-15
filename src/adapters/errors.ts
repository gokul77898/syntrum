import type { DocumentSnapshot } from "./types.js";

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class ExtensionNotConnectedError extends AdapterError {
  constructor(workspaceId: string) {
    super(
      `No VS Code extension host is connected for workspace '${workspaceId}'`,
      "EXTENSION_NOT_CONNECTED",
      { workspaceId }
    );
    this.name = "ExtensionNotConnectedError";
  }
}

export class DocumentConflictError extends AdapterError {
  constructor(readonly current: DocumentSnapshot) {
    super(
      `Document '${current.path}' is at version ${current.version}`,
      "VERSION_CONFLICT",
      { current }
    );
    this.name = "DocumentConflictError";
  }
}
