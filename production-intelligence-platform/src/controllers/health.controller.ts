import { Request, Response, NextFunction } from "express";
import { checkDatabaseConnection } from "../database/health.js";
import {
  getApplicationState
} from "../server/lifecycle.js";


import {
  checkRedisHealth
} from "../redis/health.js";
import { error } from "node:console";


export const livenessController = (
  _req: Request,
  res: Response
) => {

  const state =
    getApplicationState();

  if (
    state === "stopped"
  ) {
    res.status(503).json({
      status: "unavailable",
      state
    });

    return;
  }

  res.status(200).json({
    status: "ok",
    state
  });
};

export const readinessController = async (
  _req: Request,
  res: Response
): Promise<void> => {

  const state =
    getApplicationState();

  if (
    state !== "ready"
  ) {
    res.status(503).json({
      success: false,
      error: {
        code:
          "SERVICE_NOT_READY",
        message:
          "Service is not ready"
      }
    });

    return;
  }

  const [
    databaseHealthy,
    redisHealthy
  ] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisHealth()
  ]);

  if (
    !databaseHealthy ||
    !redisHealthy
  ) {
    res.status(503).json({
      success: false,
      error: {
        code:
          "DEPENDENCY_NOT_READY",
        message:
          "One or more dependencies are unavailable"
      }
    });

    return;
  }

  res.status(200).json({
    status: "ready",
    state,
    dependencies: {
      postgres: "connected",
      redis: "connected"
    }
  });
};



// export const healthController = async (
//   _req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     await checkDatabaseConnection();

//     res.status(200).json({
//       status: "ok",
//       service: "production-intelligence-platform",
//       database: "connected"
//     });
//   } catch (error) {
//     next(error);
//   }
// };


export const healthController = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {

  try {

    const [
      databaseHealthy,
      redisHealthy
    ] = await Promise.all([
      checkDatabaseConnection(),
      checkRedisHealth()
    ]);

    const healthy =
      databaseHealthy &&
      redisHealthy;

    if (!healthy) {
      res.status(503).json({
        status: "unhealthy",
        service:
          "production-intelligence-platform",
        dependencies: {
          postgres:
            databaseHealthy
              ? "connected"
              : "unavailable",

          redis:
            redisHealthy
              ? "connected"
              : "unavailable"
        }
      });

      return;
    }

    res.status(200).json({
      status: "ok",
      service:
        "production-intelligence-platform",
      dependencies: {
        postgres: "connected",
        redis: "connected"
      }
    });

  } catch (error) {
    next(error);
  }
};