import {
  Request,
  Response,
  NextFunction
} from "express";

import { logger } from "../logging/logger.js";




export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const startedAt = Date.now();



  res.on("finish", () => {

    const durationMs =
      Date.now() - startedAt;

    logger.info(
      "HTTP request completed",
      {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs
      }
    );
  });

  next();
};

