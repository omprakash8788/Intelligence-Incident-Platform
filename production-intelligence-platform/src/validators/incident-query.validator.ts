import type { Request } from "express";
import { ValidationError } from "../errors/ValidationError.js";

const validSeverities = [
  "low",
  "medium",
  "high",
  "critical"
] as const;

const validStatuses = [
  "detected",
  "investigating",
  "acknowledged",
  "mitigating",
  "resolved",
  "closed"
] as const;

export const validateIncidentQuery = (
  req: Request
) => {

  const page = Number(req.query.page ?? 1);

  const limit = Number(req.query.limit ?? 20);

  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError(
      "page must be a positive integer",
      "INVALID_PAGE"
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new ValidationError(
      "limit must be between 1 and 100",
      "INVALID_LIMIT"
    );
  }

  if (
    req.query.severity &&
    !validSeverities.includes(
      req.query.severity as any
    )
  ) {
    throw new ValidationError(
      "Invalid severity",
      "INVALID_SEVERITY"
    );
  }

  if (
    req.query.status &&
    !validStatuses.includes(
      req.query.status as any
    )
  ) {
    throw new ValidationError(
      "Invalid status",
      "INVALID_STATUS"
    );
  }
};