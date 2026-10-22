import {
  Request,
  Response,
  NextFunction
} from "express";

import { logger } from "../logging/logger.js";
import { httpMetrics } from "../services/http-metrics.service.js";

export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startedAt = Date.now();

  httpMetrics.requestStarted();

  let finished = false;

  const recordCompletion = (): void => {
    if (finished) {
      return;
    }

    finished = true;

    const durationMs =
      Date.now() - startedAt;

    httpMetrics.requestFinished(
      res.statusCode,
      durationMs
    );

    logger.info(
      "HTTP request completed",
      {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs
      }
    );
  };

  res.once("finish", recordCompletion);

  res.once("close", () => {
    if (!finished) {
      recordCompletion();
    }
  });

  next();
};