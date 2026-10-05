import { Redis } from "ioredis";

import { env } from "../config/env.js";

export const redis =
  new Redis({
    host:
      env.redis.host,

    port:
      env.redis.port,



    lazyConnect: true,

    connectTimeout:
      env.redis.connectTimeoutMs,

    maxRetriesPerRequest: null,

    retryStrategy: (
      times: number
    ): number => {
      const delay =
        Math.min(
          times * 500,
          5000
        );

      return delay;
    }

  });

