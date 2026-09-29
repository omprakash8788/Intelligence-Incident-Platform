import { Request, Response, NextFunction } from "express";
import { checkDatabaseConnection } from "../database/health.js";
import {
  getApplicationState
} from "../server/lifecycle.js";





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
) => {

  const state =
    getApplicationState();

  if (
    state !== "ready"
  ) {
    res.status(503).json({
      status: "not_ready",
      state
    });

    return;
  }

  try {

    await checkDatabaseConnection();

    res.status(200).json({
      status: "ready",
      state,
      dependencies: {
        postgres: "connected"
      }
    });

  } catch (error) {

    res.status(503).json({
      status: "not_ready",
      state,
      dependencies: {
        postgres: "unavailable"
      }
    });
  }
};


export const healthController = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await checkDatabaseConnection();

    res.status(200).json({
      status: "ok",
      service: "production-intelligence-platform",
      database: "connected"
    });
  } catch (error) {
    next(error);
  }
};


