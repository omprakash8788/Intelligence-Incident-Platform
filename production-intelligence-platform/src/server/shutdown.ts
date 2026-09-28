import type { Server } from "node:http";

import { pool } from "../database/pool.js";
import { logger } from "../logging/logger.js";

let isShuttingDown = false;

export const shutdown = async (
  server: Server,
  signal: string
): Promise<void> => {

  if (isShuttingDown) {
    logger.warn(
      "Shutdown already in progress",
      {
        signal
      }
    );

    return;
  }

  isShuttingDown = true;

  logger.info(
    "Graceful shutdown started",
    {
      signal
    }
  );

  try {

    await new Promise<void>(
      (resolve, reject) => {

        server.close(
          (error) => {

            if (error) {
              reject(error);
              return;
            }

            resolve();
          }
        );
      }
    );

    logger.info(
      "HTTP server closed"
    );

    await pool.end();

    logger.info(
      "PostgreSQL connection pool closed"
    );

    logger.info(
      "Graceful shutdown completed"
    );

    process.exitCode = 0;

  } catch (error) {

    logger.error(
      "Graceful shutdown failed",
      {
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );

    process.exitCode = 1;
  }
};

