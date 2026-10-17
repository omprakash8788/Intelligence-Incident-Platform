import { Router } from "express";

import {
  enqueueIdempotencyJob
} from "../queues/producers/idempotency.producer.js";

export const idempotencyRoutes = Router();

const MAX_KEY_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;

idempotencyRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const idempotencyKey: unknown =
        req.body?.idempotencyKey;

      const message: unknown =
        req.body?.message;

      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.trim().length === 0 ||
        idempotencyKey.length > MAX_KEY_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_IDEMPOTENCY_KEY",
            message:
              `idempotencyKey must contain 1 to ${MAX_KEY_LENGTH} characters`
          }
        });
        return;
      }

      if (
        typeof message !== "string" ||
        message.trim().length === 0 ||
        message.length > MAX_MESSAGE_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
          }
        });
        return;
      }

      const jobId = await enqueueIdempotencyJob({
        idempotencyKey: idempotencyKey.trim(),
        message: message.trim()
      });

      res.status(202).json({
        success: true,
        data: {
          jobId,
          idempotencyKey: idempotencyKey.trim(),
          state: "accepted"
        }
      });
    } catch (error) {
      next(error);
    }
  }
);