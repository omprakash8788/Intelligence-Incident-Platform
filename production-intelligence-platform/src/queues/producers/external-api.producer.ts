import { randomUUID } from "node:crypto";

import {
  externalApiQueue
} from "../external-api.queue.js";

import type {
  ExternalApiJobData
} from "../jobs/external-api.job.js";

export const enqueueExternalApiRequest =
  async (
    message: string
  ) => {
    const data: ExternalApiJobData = {
      requestId: randomUUID(),
      message
    };

    const job = await externalApiQueue.add(
      "external-api-request",
      data
    );

    return {
      jobId: String(job.id),
      requestId: data.requestId,
      message: data.message
    };
  };

export const enqueueExternalApiBatch =
  async (
    count: number
  ) => {
    const jobs = Array.from(
      { length: count },
      (_, index) => ({
        name: "external-api-request",
        data: {
          requestId: randomUUID(),
          message: `Rate-limit test request ${index + 1}`
        } satisfies ExternalApiJobData
      })
    );

    const addedJobs =
      await externalApiQueue.addBulk(jobs);

    return addedJobs.map((job) => ({
      jobId: String(job.id),
      requestId: job.data.requestId
    }));
  };

  