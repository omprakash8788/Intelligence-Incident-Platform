import { Router } from "express";

import {
  externalApiQueue
} from "../queues/external-api.queue.js";

import {
  enqueueExternalApiBatch,
  enqueueExternalApiRequest
} from "../queues/producers/external-api.producer.js";

import {
  workerPerformanceMetrics
} from "../services/worker-performance-metrics.service.js";

const router = Router();

router.post(
  "/demo/external-api/jobs",
  async (req, res, next) => {
    try {
      const message = req.body?.message;

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

      const job =
        await enqueueExternalApiRequest(
          message.trim()
        );

      res.status(202).json({
        success: true,
        data: job
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/monitoring/workers/external-api",
  (_req, res) => {
    res.status(200).json({
      success: true,
      data: workerPerformanceMetrics.snapshot()
    });
  }
);

router.post(
  "/demo/external-api/jobs/bulk",
  async (req, res, next) => {
    try {
      const count = req.body?.count;

      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 20
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_COUNT",
            message:
              "count must be an integer between 1 and 20"
          }
        });

        return;
      }

      const jobs =
        await enqueueExternalApiBatch(count);

      res.status(202).json({
        success: true,
        data: {
          submitted: jobs.length,
          jobs
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/monitoring/queues/external-api",
  async (_req, res, next) => {
    try {
      const counts =
        await externalApiQueue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "completed",
          "failed"
        );

      res.status(200).json({
        success: true,
        data: {
          queue: "external-api",
          counts: {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0
          },
          rateLimit: {
            max: 3,
            durationMs: 5000
          },
          sampledAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

