import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/AppError.js";
import type { ApiErrorResponse } from "../types/api-response.js";


export const errorMiddleware = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  // if (err instanceof AppError) {
  //   res.status(err.statusCode).json({
  //     success: false,
  //     error: {
  //       code: err.code,
  //       message: err.message
  //     }
  //   });
  if (err instanceof AppError) {

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

  console.error(err);

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error"
    }
  });
};