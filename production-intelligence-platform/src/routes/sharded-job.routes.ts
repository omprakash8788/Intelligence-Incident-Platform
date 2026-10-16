import { Router } from "express";

import {
  getShardedJobStatus,
  submitShardedJob
} from "../services/sharded-job.service.js";

export const shardedJobRoutes = Router();

const MAX_MESSAGE_LENGTH = 500;
const MAX_PARTITION_KEY_LENGTH = 100;

shardedJobRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const partitionKey: unknown =
        req.body?.partitionKey;

      const message: unknown =
        req.body?.message;

      if (
        typeof partitionKey !== "string" ||
        partitionKey.trim().length === 0 ||
        partitionKey.length > MAX_PARTITION_KEY_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_PARTITION_KEY",
            message:
              `partitionKey must contain 1 to ${MAX_PARTITION_KEY_LENGTH} characters`
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

      const result = await submitShardedJob({
        partitionKey,
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

shardedJobRoutes.get(
  "/:shardIndex/:jobId",
  async (req, res, next) => {
    try {
      const rawShardIndex = req.params.shardIndex;

      if (!/^(0|[1-9]\d*)$/.test(rawShardIndex)) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_SHARD_INDEX",
            message: "Shard index must be a non-negative integer"
          }
        });
        return;
      }

      const shardIndex = Number(rawShardIndex);

      const result = await getShardedJobStatus(
        shardIndex,
        req.params.jobId
      );

      if (!result) {
        res.status(404).json({
          success: false,
          error: {
            code: "SHARDED_JOB_NOT_FOUND",
            message: "Job was not found in the specified shard"
          }
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_SHARD_INDEX",
            message: error.message
          }
        });
        return;
      }

      next(error);
    }
  }
);