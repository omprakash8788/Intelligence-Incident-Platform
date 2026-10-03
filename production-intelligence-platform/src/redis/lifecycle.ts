import { redis } from "./client.js";

import { logger } from "../logging/logger.js";

export const connectRedis =
  async (): Promise<void> => {
    try {
      await redis.connect();

      await redis.ping();

      logger.info(
        "Redis connected",
        {
          host:
            redis.options.host,
          port:
            redis.options.port
        }
      );
    } catch (error) {
      logger.error(
        "Redis connection failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      throw error;
    }
  };

export const closeRedis =
  async (): Promise<void> => {
    if (
      redis.status ===
      "end"
    ) {
      return;
    }

    try {
      await redis.quit();

      logger.info(
        "Redis connection closed"
      );
    } catch (error) {
      logger.error(
        "Redis shutdown failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      throw error;
    }
  };