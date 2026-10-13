import { Router } from "express";

import type {
  DemoJobMode,
  DemoJobPriority
} from "../queues/jobs/demo.job.js";

import {
  routeQueueJob
} from "../services/queue-routing.service.js";

const router = Router();

const isDemoJobMode = (
  value: unknown
): value is DemoJobMode => {
  return (
    typeof value === "string" &&
    [
      "success",
      "slow",
      "failure",
      "fail-twice",
      "retryable",
      "non-retryable",
      "delayed",
      "progress"
    ].includes(value)
  );
};

const isDemoJobPriority = (
  value: unknown
): value is DemoJobPriority => {
  return (
    value === 1 ||
    value === 2 ||
    value === 5 ||
    value === 10
  );
};

router.post(
  "/demo/routed-jobs",
  async (req, res, next) => {
    try {
      const body: unknown = req.body;

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST_BODY",
            message:
              "Request body must be a JSON object"
          }
        });

        return;
      }

      const requestBody = body as Record<
        string,
        unknown
      >;

      const target = requestBody.target;
      const message = requestBody.message;

      if (
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_MESSAGE",
            message:
              "message must be a non-empty string"
          }
        });

        return;
      }

      const normalizedMessage = message.trim();

      if (normalizedMessage.length > 1000) {
        res.status(400).json({
          success: false,
          error: {
            code: "MESSAGE_TOO_LONG",
            message:
              "message must not exceed 1000 characters"
          }
        });

        return;
      }

      if (target === "demo") {
        const mode = requestBody.mode;
        const priority = requestBody.priority;

        if (!isDemoJobMode(mode)) {
          res.status(400).json({
            success: false,
            error: {
              code: "INVALID_DEMO_MODE",
              message:
                "mode must be a supported demo job mode"
            }
          });

          return;
        }

        if (
          priority !== undefined &&
          !isDemoJobPriority(priority)
        ) {
          res.status(400).json({
            success: false,
            error: {
              code: "INVALID_PRIORITY",
              message:
                "priority must be 1, 2, 5, or 10"
            }
          });

          return;
        }

        const result = await routeQueueJob({
          target: "demo",
          message: normalizedMessage,
          mode,
          ...(priority === undefined
            ? {}
            : { priority })
        });

        res.status(202).json({
          success: true,
          data: {
            target: "demo",
            result
          }
        });

        return;
      }

      if (target === "external-api") {
        const result = await routeQueueJob({
          target: "external-api",
          message: normalizedMessage
        });

        res.status(202).json({
          success: true,
          data: {
            target: "external-api",
            result
          }
        });

        return;
      }

      res.status(400).json({
        success: false,
        error: {
          code: "INVALID_QUEUE_TARGET",
          message:
            'target must be "demo" or "external-api"'
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;