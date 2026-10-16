import { randomUUID } from "node:crypto";

import {
  interactiveWorkloadQueue,
  batchWorkloadQueue
} from "../queues/workload.queues.js";

import type {
  WorkloadJobData,
  WorkloadType
} from "../queues/jobs/workload.job.js";

import {
  resolveWorkloadQueue
} from "./workload-routing.policy.js";

const MAX_MESSAGE_LENGTH = 500;

export interface SubmitWorkloadInput {
  workloadType: WorkloadType;
  message: string;
}

export interface SubmitWorkloadResult {
  workloadId: string;
  jobId: string;
  workloadType: WorkloadType;
  queueName: string;
}

export const submitWorkload = async (
  input: SubmitWorkloadInput
): Promise<SubmitWorkloadResult> => {
  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError(
      `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
    );
  }

  const queueName = resolveWorkloadQueue(
    input.workloadType
  );

  const workloadId = randomUUID();

  const data: WorkloadJobData = {
    workloadId,
    workloadType: input.workloadType,
    message: input.message.trim(),
    submittedAt: new Date().toISOString()
  };

  const queue =
    input.workloadType === "interactive"
      ? interactiveWorkloadQueue
      : batchWorkloadQueue;

  const job = await queue.add(
    "process-workload",
    data
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return {
    workloadId,
    jobId: job.id,
    workloadType: input.workloadType,
    queueName
  };
};