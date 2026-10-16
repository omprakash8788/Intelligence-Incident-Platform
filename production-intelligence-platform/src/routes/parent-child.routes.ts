import { Router } from "express";

import {
  getParentChildBatchStatus,
  submitParentChildBatch
} from "../services/parent-child.service.js";

export const parentChildRoutes = Router();

const MAX_BATCH_SIZE = 20;
const MAX_ITEM_LENGTH = 200;

parentChildRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const items: unknown = req.body?.items;

      if (!Array.isArray(items)) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The items field must be an array"
          }
        });
        return;
      }

      if (
        items.length === 0 ||
        items.length > MAX_BATCH_SIZE
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `Submit between 1 and ${MAX_BATCH_SIZE} items`
          }
        });
        return;
      }

      const validItems = items.every(
        (item: unknown) =>
          typeof item === "string" &&
          item.trim().length > 0 &&
          item.length <= MAX_ITEM_LENGTH
      );

      if (!validItems) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `Each item must be a non-empty string of at most ${MAX_ITEM_LENGTH} characters`
          }
        });
        return;
      }

      const result = await submitParentChildBatch(
        items as string[]
      );

      res.status(202).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

parentChildRoutes.get(
  "/:parentJobId",
  async (req, res, next) => {
    try {
      const result =
        await getParentChildBatchStatus(
          req.params.parentJobId
        );

      if (!result) {
        res.status(404).json({
          success: false,
          error: {
            code: "PARENT_JOB_NOT_FOUND",
            message: "Parent job was not found"
          }
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);