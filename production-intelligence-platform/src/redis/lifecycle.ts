import { redis } from "./client.js";

import { logger } from "../logging/logger.js";


let eventsRegistered =
  false;

export const registerRedisEvents =
  (): void => {
    if (eventsRegistered) {
      return;
    }

    eventsRegistered =
      true;

    redis.on(
      "connect",
      () => {
        logger.info(
          "Redis socket connected"
        );
      }
    );

    redis.on(
      "ready",
      () => {
        logger.info(
          "Redis client ready"
        );
      }
    );

    redis.on(
      "error",
      (error: Error) => {
        logger.error(
          "Redis connection error",
          {
            error:
              error.message
          }
        );
      }
    );

    redis.on(
      "close",
      () => {
        logger.warn(
          "Redis connection closed"
        );
      }
    );

    redis.on(
      "reconnecting",
      (delay: number) => {
        logger.warn(
          "Redis reconnecting",
          {
            delayMs: delay
          }
        );
      }
    );

    redis.on(
      "end",
      () => {
        logger.info(
          "Redis connection ended"
        );
      }
    );
  };

export const connectRedis =
  async (): Promise<void> => {
    registerRedisEvents();
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

export const isRedisReady =
  (): boolean => {
    return (
      redis.status ===
      "ready"
    );
  };