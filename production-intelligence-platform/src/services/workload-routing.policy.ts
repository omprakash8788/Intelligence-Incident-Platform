import {
  INTERACTIVE_WORKLOAD_QUEUE,
  BATCH_WORKLOAD_QUEUE
} from "../queues/workload.queue-names.js";

import type {
  WorkloadType
} from "../queues/jobs/workload.job.js";

export const resolveWorkloadQueue = (
  workloadType: WorkloadType
): string => {
  switch (workloadType) {
    case "interactive":
      return INTERACTIVE_WORKLOAD_QUEUE;

    case "batch":
      return BATCH_WORKLOAD_QUEUE;

    default: {
      const exhaustiveCheck: never = workloadType;

      throw new Error(
        `Unsupported workload type: ${exhaustiveCheck}`
      );
    }
  }
};