import { Router } from "express";

import { enqueueDistributedLockJob } from "../queues/producers/distributed-lock.producer.js";

export const distributedLockRoutes = Router();

distributedLockRoutes.post("/worker", async (req, res) => {
  const body: unknown = req.body;

  if (
    typeof body !== "object" ||
    body === null ||
    !("reportId" in body) ||
    !("workMs" in body)
  ) {
    res.status(400).json({
      success: false,
      message: "reportId and workMs are required"
    });

    return;
  }

  const { reportId, workMs } = body;

  if (
    typeof reportId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(reportId)
  ) {
    res.status(400).json({
      success: false,
      message: "reportId must contain 1-100 letters, numbers, underscores, or hyphens"
    });

    return;
  }

  if (
    typeof workMs !== "number" ||
    !Number.isInteger(workMs) ||
    workMs < 100 ||
    workMs > 25_000
  ) {
    res.status(400).json({
      success: false,
      message: "workMs must be an integer between 100 and 25000"
    });

    return;
  }

  try {
    const jobId = await enqueueDistributedLockJob({
      reportId,
      workMs
    });

    res.status(202).json({
      success: true,
      message: "Distributed-lock demonstration job queued",
      jobId,
      reportId,
      workMs
    });
  } catch (error) {
    console.error(
      "[distributed-lock] Failed to enqueue job",
      error
    );

    res.status(503).json({
      success: false,
      message: "Unable to enqueue the job"
    });
  }
});