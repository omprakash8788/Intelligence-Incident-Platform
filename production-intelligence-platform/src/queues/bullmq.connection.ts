import {
  env
} from "../config/env.js";

export const createBullMQConnection = (
  maxRetriesPerRequest: number | null
) => {
  return {
    host: env.redis.host,

    port: env.redis.port,

    connectTimeout:
      env.redis.connectTimeoutMs,

    maxRetriesPerRequest,

    retryStrategy: (
      times: number
    ): number => {
      return Math.min(
        times * 500,
        5000
      );
    }
  };
};

// Need to update in doc