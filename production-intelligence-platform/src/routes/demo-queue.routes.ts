import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";


import type {
  DemoJobMode
} from "../queues/jobs/demo.job.js";
import { getDemoJobStatus } from "../services/demo-job.service.js";

const router =
  Router();

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
        mode
      } = req.body as {
        message?: unknown;
        mode?: unknown;
      };

      if (
        typeof message !==
        "string"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MESSAGE",
            message:
              "message must be a string"
          }
        });

        return;
      }

      if (
        mode !== "success" &&
        mode !== "slow" &&
        mode !== "failure" &&
        mode !== "fail-twice" &&
        mode !== "retryable" &&
        mode !== "non-retryable"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MODE",
            message:
               "mode must be success, slow, failure, fail-twice, retryable, or non-retryable"
          }
        });

        return;
      }

      const jobId =
        await addDemoJob({
          message,
          mode: mode as DemoJobMode
        });

      res.status(202).json({
        success: true,
        data: {
          jobId
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

export default router;

