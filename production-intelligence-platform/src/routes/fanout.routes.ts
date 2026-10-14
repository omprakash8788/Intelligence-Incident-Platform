import {
  Router
} from "express";

import {
  fanoutAggregateQueue
} from "../queues/fanout.queues.js";

import {
  createFanoutWorkflow
} from "../services/fanout.service.js";

const router = Router();

router.post(
  "/demo/fanout",
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

      const items =
        requestBody.items;

      if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 10
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_ITEMS",
            message:
              "items must be an array containing between 1 and 10 strings"
          }
        });

        return;
      }

      const validItems =
        items.every(
          (item) =>
            typeof item === "string" &&
            item.trim().length > 0 &&
            item.length <= 500
        );

      if (!validItems) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_ITEM_VALUE",
            message:
              "Every item must be a non-empty string of at most 500 characters"
          }
        });

        return;
      }

      const workflow =
        await createFanoutWorkflow(
          items as string[]
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
  "/demo/fanout/:parentJobId",
  async (req, res, next) => {
    try {
      const parentJobId =
        req.params.parentJobId;

      const job =
        await fanoutAggregateQueue.getJob(
          parentJobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "FANOUT_WORKFLOW_NOT_FOUND",
            message:
              "The fan-out parent job was not found"
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
          expectedChildren:
            job.data.expectedChildren,
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

