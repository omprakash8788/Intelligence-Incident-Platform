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