import { Router } from "express";
import { enqueueDemoBatch } from "../services/batch-enqueue.service.js";

export const batchRoutes = Router();

const MAX_BATCH_SIZE = 100;
const MAX_MESSAGE_LENGTH = 500;

batchRoutes.post("/", async (req, res, next) => {
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
          message: `Submit between 1 and ${MAX_BATCH_SIZE} items`
        }
      });
      return;
    }

    const validItems = items.every(
      (item: unknown) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= MAX_MESSAGE_LENGTH
    );

    if (!validItems) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message:
            `Each item must be a non-empty string of at most ${MAX_MESSAGE_LENGTH} characters`
        }
      });
      return;
    }

    const result = await enqueueDemoBatch(items as string[]);

    res.status(202).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});