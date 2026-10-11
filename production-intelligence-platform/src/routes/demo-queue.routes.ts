import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";


import type {
  DemoJobMode,
  DemoJobPriority
} from "../queues/jobs/demo.job.js";

import { getDemoJobStatus } from "../services/demo-job.service.js";


import {
  demoQueue
} from "../queues/demo.queue.js";


const router =
  Router();


const isDemoJobMode = (
  value: unknown
): value is DemoJobMode => {
  return (
    value === "success" ||
    value === "slow" ||
    value === "failure" ||
    value === "fail-twice" ||
    value === "retryable" ||
    value === "non-retryable" ||
    value === "delayed" ||
    value === "progress"
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

const parsePriority = (
  value: unknown
): DemoJobPriority | null => {
  if (value === undefined) {
    return 5;
  }

  if (isDemoJobPriority(value)) {
    return value;
  }

  return null;
};

router.post(
  "/demo/jobs",
  async (
    req,
    res,
    next
  ) => {

    try {

      const {
        message,
        mode,
        priority
      } = req.body as {
        message?: unknown;
        mode?: unknown;
        priority?: unknown;
      };

      if (
        typeof message !== "string" ||
        message.trim() === ""
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MESSAGE",
            message:
              "message must be a non-empty string"
          }
        });

        return;
      }

      if (!isDemoJobMode(mode)) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_MODE",
            message:
              "mode is not supported"
          }
        });
        return;
      }

      const parsedPriority =
        parsePriority(priority);

      if (parsedPriority === null) {
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

      const jobId =
        await addDemoJob(
          {
            message: message.trim(),
            mode
          }, {
          priority: parsedPriority
        }
        );

      res.status(202).json({
        success: true,
        data: {
          jobId,
          priority: parsedPriority
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/demo/jobs/delayed",
  async (req, res, next) => {
    try {
      const {
        message,
        delayMs,
        priority
      } = req.body as {
        message?: unknown;
        delayMs?: unknown;
        priority?: unknown;
      };

      if (
        typeof message !== "string" ||
        message.trim() === ""
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

      if (
        typeof delayMs !== "number" ||
        !Number.isInteger(delayMs) ||
        delayMs < 1000 ||
        delayMs > 86_400_000
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_DELAY",
            message:
              "delayMs must be an integer between 1000 and 86400000"
          }
        });
        return;
      }

      const parsedPriority =
        parsePriority(priority);

      if (parsedPriority === null) {
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

      const jobId = await addDemoJob(
        {
          message: message.trim(),
          mode: "delayed"
        },
        {
          delayMs,
          priority: parsedPriority
        }
      );

      res.status(202).json({
        success: true,
        data: {
          jobId,
          state: "scheduled",
          delayMs,
          priority: parsedPriority
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/demo/jobs/:jobId/progress",
  async (req, res, next) => {
    try {
      const job =
        await getDemoJobStatus(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code: "JOB_NOT_FOUND",
            message: "Demo job not found"
          }
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          jobId: job.id,
          state: job.state,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/demo/jobs/:jobId",
  async (
    req,
    res,
    next
  ) => {

    try {

      const job =
        await getDemoJobStatus(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "JOB_NOT_FOUND",
            message:
              "Demo job not found"
          }
        });

        return;
      }

      res.status(200).json({
        success: true,
        data: job
      });

    } catch (error) {
      next(error);
    }
  }
);


router.delete(
  "/demo/jobs/:jobId",
  async (req, res, next) => {
    try {
      const job =
        await demoQueue.getJob(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code: "JOB_NOT_FOUND",
            message: "Demo job not found"
          }
        });
        return;
      }

      const state =
        await job.getState();

      if (state !== "delayed") {
        res.status(409).json({
          success: false,
          error: {
            code: "JOB_NOT_DELAYED",
            message:
              "Only jobs currently in the delayed state can be cancelled by this endpoint"
          }
        });
        return;
      }

      await job.remove();

      res.status(200).json({
        success: true,
        data: {
          jobId: req.params.jobId,
          cancelled: true
        }
      });
    } catch (error) {
      next(error);
    }
  }
);


export default router;

