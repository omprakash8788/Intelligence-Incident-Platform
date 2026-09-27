import {
  randomUUID
} from "node:crypto";

import {
  Request,
  Response,
  NextFunction
} from "express";

import {
  runWithRequestContext
} from "../logging/request-context.js";

const REQUEST_ID_HEADER =
  "x-request-id";

const MAX_REQUEST_ID_LENGTH = 128;

const isValidRequestId = (
  value: string
): boolean => {
  return (
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH
  );
};

export const requestContextMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const incomingRequestId =
    req.header(REQUEST_ID_HEADER);

  const requestId =
    incomingRequestId &&
    isValidRequestId(incomingRequestId)
      ? incomingRequestId
      : randomUUID();

  res.setHeader(
    "X-Request-ID",
    requestId
  );

  runWithRequestContext(
    { requestId },
    () => {
      next();
    }
  );
};