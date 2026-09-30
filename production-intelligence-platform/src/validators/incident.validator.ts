// import { Request } from "express";
// import { ValidationError } from "../errors/ValidationError.js";

// export const validateCreateIncident = (
//   req: Request
// ) => {
//   const { service, severity } = req.body;

//   if (
//     typeof service !== "string" ||
//     service.trim().length === 0
//   ) {
//     throw new ValidationError(
//       "Service is required",
//       "SERVICE_REQUIRED"
//     );
//   }

//   const validSeverities = [
//     "low",
//     "medium",
//     "high",
//     "critical"
//   ];

//   if (!validSeverities.includes(severity)) {
//     throw new ValidationError(
//       "Invalid severity",
//       "INVALID_SEVERITY"
//     );
//   }
// };


import { Request } from "express";

import {
  ValidationError
} from "../errors/ValidationError.js";

const validSeverities = [
  "low",
  "medium",
  "high",
  "critical"
] as const;

const MAX_SERVICE_LENGTH = 100;

export const validateCreateIncident = (
  req: Request
) => {

  const {
    service,
    severity
  } = req.body;

  if (
    typeof service !== "string" ||
    service.trim().length === 0
  ) {
    throw new ValidationError(
      "Service is required",
      "SERVICE_REQUIRED"
    );
  }

  const normalizedService =
    service.trim();

  if (
    normalizedService.length >
    MAX_SERVICE_LENGTH
  ) {
    throw new ValidationError(
      "Service must not exceed 100 characters",
      "SERVICE_TOO_LONG"
    );
  }

  if (
    !validSeverities.includes(
      severity
    )
  ) {
    throw new ValidationError(
      "Invalid severity",
      "INVALID_SEVERITY"
    );
  }
};