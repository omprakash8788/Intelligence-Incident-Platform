// import {
//   redis
// } from "./client.js";

// export const checkRedisHealth =
//   async (): Promise<boolean> => {
//     try {
//       const result =
//         await redis.ping();

//       return result === "PONG";
//     } catch {
//       return false;
//     }
//   };

import {
  redis
} from "./client.js";

const REDIS_HEALTH_TIMEOUT_MS = 2000;

export const checkRedisHealth =
  async (): Promise<boolean> => {

    try {

      const pingPromise =
        redis.ping();

      const timeoutPromise =
        new Promise<never>(
          (_, reject) => {
            setTimeout(
              () => {
                reject(
                  new Error(
                    "Redis health check timed out"
                  )
                );
              },
              REDIS_HEALTH_TIMEOUT_MS
            );
          }
        );

      const result =
        await Promise.race([
          pingPromise,
          timeoutPromise
        ]);

      return result === "PONG";

    } catch {
      return false;
    }
  };
