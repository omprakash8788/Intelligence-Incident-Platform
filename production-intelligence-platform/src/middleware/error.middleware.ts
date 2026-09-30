import {
  Request,
  Response,
  NextFunction
} from "express";

import { AppError } from "../errors/AppError.js";
import { logger } from "../logging/logger.js";
import type { ApiErrorResponse } from "../types/api-response.js";

export const errorMiddleware = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {

  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    err.type ===
      "entity.too.large"
  ) {

    logger.warn(
      "Request payload too large",
      {
        method:
          req.method,
        path:
          req.originalUrl
      }
    );

    const response:
      ApiErrorResponse = {
        success: false,
        error: {
          code:
            "PAYLOAD_TOO_LARGE",
          message:
            "Request payload is too large"
        }
      };

    res
      .status(413)
      .json(response);

    return;
  }

  if (
  err &&
  typeof err === "object" &&
  "type" in err &&
  err.type ===
    "entity.parse.failed"
) {

  logger.warn(
    "Invalid JSON payload",
    {
      method:
        req.method,
      path:
        req.originalUrl
    }
  );

  const response:
    ApiErrorResponse = {
      success: false,
      error: {
        code:
          "INVALID_JSON",
        message:
          "Invalid JSON payload"
      }
    };

  res
    .status(400)
    .json(response);

  return;
}

  if (err instanceof AppError) {

    logger.warn(
      "Application error",
      {
        method: req.method,
        path: req.originalUrl,
        code: err.code,
        statusCode: err.statusCode,
        message: err.message
      }
    );

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message
      }
    };

    res
      .status(err.statusCode)
      .json(response);

    return;
  }

  logger.error(
    "Unhandled application error",
    {
      method: req.method,
      path: req.originalUrl,
      error:
        err instanceof Error
          ? err.message
          : String(err)
    }
  );

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error"
    }
  });
};