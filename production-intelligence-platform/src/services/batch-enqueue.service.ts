import { demoQueue } from "../queues/demo.queue.js";

const MAX_BATCH_SIZE = 100;
const MAX_MESSAGE_LENGTH = 500;

export interface BatchEnqueueResult {
  count: number;
  jobIds: string[];
}

export const enqueueDemoBatch = async (
  messages: string[]
): Promise<BatchEnqueueResult> => {
  if (!Array.isArray(messages)) {
    throw new TypeError("Messages must be an array");
  }

  if (
    messages.length === 0 ||
    messages.length > MAX_BATCH_SIZE
  ) {
    throw new RangeError(
      `Batch size must be between 1 and ${MAX_BATCH_SIZE}`
    );
  }

  for (const message of messages) {
    if (
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      throw new TypeError(
        `Each message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
      );
    }
  }

  const jobs = await demoQueue.addBulk(
    messages.map((message) => ({
      name: "batch-demo-job",
      data: {
        message: message.trim(),
        mode: "success" as const,
        priority: 5 as const
      }
    }))
  );

  return {
    count: jobs.length,
    jobIds: jobs.map((job) => job.id).filter(
      (jobId): jobId is string => typeof jobId === "string"
    )
  };
};

