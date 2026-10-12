import {
  Router
} from "express";

import {
  getDemoQueueMetrics
} from "../services/demo-queue-metrics.service.js";

const router = Router();

router.get(
  "/monitoring/queues/demo",
  async (_req, res, next) => {
    try {
      const metrics =
        await getDemoQueueMetrics();

      const statusCode =
        metrics.health === "healthy"
          ? 200
          : 503;

      res.status(statusCode).json({
        success:
          metrics.health === "healthy",
        data: metrics
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

