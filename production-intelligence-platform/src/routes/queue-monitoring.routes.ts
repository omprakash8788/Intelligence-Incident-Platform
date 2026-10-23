import {
  Router
} from "express";

import {
  getDemoQueueMetrics
} from "../services/demo-queue-metrics.service.js";

import {
  httpMetrics
} from "../services/http-metrics.service.js";


import {
  getQueueObservability
} from "../services/queue-observability.service.js";

import {
  workerMetrics
} from "../services/worker-metrics.service.js";


const router = Router();

router.get(
  "/monitoring/metrics",
  (_req, res) => {
    res.status(200).json({
      success: true,
      data: httpMetrics.snapshot()
    });
  }
);


router.get(
  "/monitoring/queues",
  async (_req, res, next) => {
    try {
      const queueMetrics =
        await getQueueObservability();

      const worker =
        workerMetrics.snapshot();

      const degraded =
        queueMetrics.queues.some(
          (queue) =>
            queue.health === "degraded"
        );

      res.status(degraded ? 503 : 200).json({
        success: !degraded,
        data: {
          ...queueMetrics,
          workers: [worker]
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

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
        success: metrics.health === "healthy",
        data: metrics
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;