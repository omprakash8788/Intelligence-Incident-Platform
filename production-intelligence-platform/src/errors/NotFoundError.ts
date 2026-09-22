import { AppError } from "./AppError.js";

export class NotFoundError extends AppError {
  constructor(
    message = "Resource not found",
    code = "RESOURCE_NOT_FOUND"
  ) {
    super(message, 404, code);
  }
}

