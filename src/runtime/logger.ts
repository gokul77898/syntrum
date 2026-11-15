import type { LogEntry, Logger } from "./types.js";

export function createConsoleLogger(): Logger {
  return entry => {
    const output = `${JSON.stringify(entry)}\n`;
    if (entry.level === "error") {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  };
}

export function log(
  logger: Logger,
  level: LogEntry["level"],
  event: string,
  message: string,
  context?: Record<string, unknown>
): void {
  logger({
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    ...(context ? { context } : {})
  });
}

export const silentLogger: Logger = () => undefined;
