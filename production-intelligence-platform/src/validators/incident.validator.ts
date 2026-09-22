import { Request } from "express";
import { ValidationError } from "../errors/ValidationError.js";

export const validateCreateIncident = (
  req: Request
) => {
  const { service, severity } = req.body;

  if (
    typeof service !== "string" ||
    service.trim().length === 0
  ) {
    throw new ValidationError(
      "Service is required",
      "SERVICE_REQUIRED"
    );
  }

  const validSeverities = [
    "low",
    "medium",
    "high",
    "critical"
  ];

  if (!validSeverities.includes(severity)) {
    throw new ValidationError(
      "Invalid severity",
      "INVALID_SEVERITY"
    );
  }
};