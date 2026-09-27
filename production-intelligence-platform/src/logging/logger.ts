import type { LogLevel } from "./log-level.js";
import type { RequestContext } from "./request-context.js";

export interface LogMetadata {
  requestId?: string;
  incidentId?: string;
  service?: string;
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  metadata?: LogMetadata;
}

const APPLICATION_NAME =
  "production-intelligence-platform";

const writeLog = (
  level: LogLevel,
  message: string,
  metadata?: LogMetadata
) => {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: APPLICATION_NAME,
    message,
    ...(metadata
      ? { metadata }
      : {})
  };

  const serialized = JSON.stringify(entry);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
};

export const logger = {
  debug(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "debug",
      message,
      metadata
    );
  },

  info(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "info",
      message,
      metadata
    );
  },

  warn(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "warn",
      message,
      metadata
    );
  },

  error(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "error",
      message,
      metadata
    );
  }
};

