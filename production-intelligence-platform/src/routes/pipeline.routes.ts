import {
  Router
} from "express";

import {
  pipelineReportQueue
} from "../queues/pipeline.queues.js";

import {
  createPipelineWorkflow
} from "../services/pipeline.service.js";

const router = Router();

router.post(
  "/demo/pipelines",
  async (req, res, next) => {
    try {
      const body: unknown =
        req.body;

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_REQUEST_BODY",
            message:
              "Request body must be a JSON object"
          }
        });

        return;
      }

      const requestBody =
        body as Record<
          string,
          unknown
        >;

      const text =
        requestBody.text;

      if (
        typeof text !== "string" ||
        text.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_TEXT",
            message:
              "text must be a non-empty string"
          }
        });

        return;
      }

      if (text.length > 2000) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "TEXT_TOO_LONG",
            message:
              "text must not exceed 2000 characters"
          }
        });

        return;
      }

      const workflow =
        await createPipelineWorkflow(
          text
        );

      res.status(202).json({
        success: true,
        data: workflow
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/demo/pipelines/:parentJobId",
  async (req, res, next) => {
    try {
      const parentJobId =
        req.params.parentJobId;

      const job =
        await pipelineReportQueue.getJob(
          parentJobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "PIPELINE_NOT_FOUND",
            message:
              "The pipeline was not found"
          }
        });

        return;
      }

      const state =
        await job.getState();

      res.status(200).json({
        success: true,
        data: {
          parentJobId,
          workflowId:
            job.data.workflowId,
          state,

          ...(state === "completed"
            ? {
                result:
                  job.returnvalue
              }
            : {}),

          ...(state === "failed"
            ? {
                failedReason:
                  job.failedReason
              }
            : {})
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;