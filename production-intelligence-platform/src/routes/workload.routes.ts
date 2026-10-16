import { Router } from "express";

import type {
  WorkloadType
} from "../queues/jobs/workload.job.js";

import {
  submitWorkload
} from "../services/workload-routing.service.js";

export const workloadRoutes = Router();

const MAX_MESSAGE_LENGTH = 500;

workloadRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const workloadType: unknown =
        req.body?.workloadType;

      const message: unknown =
        req.body?.message;

      if (
        workloadType !== "interactive" &&
        workloadType !== "batch"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_WORKLOAD_TYPE",
            message:
              "workloadType must be interactive or batch"
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
              `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
          }
        });
        return;
      }

      const result = await submitWorkload({
        workloadType: workloadType as WorkloadType,
        message
      });

      res.status(202).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);