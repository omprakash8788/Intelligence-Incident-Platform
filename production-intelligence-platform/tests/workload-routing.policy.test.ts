import {
  describe,
  expect,
  it
} from "vitest";

import {
  resolveWorkloadQueue
} from "../src/services/workload-routing.policy.js";

import {
  INTERACTIVE_WORKLOAD_QUEUE,
  BATCH_WORKLOAD_QUEUE
} from "../src/queues/workload.queue-names.js";

describe("resolveWorkloadQueue", () => {
  it("routes interactive workloads to the interactive queue", () => {
    expect(
      resolveWorkloadQueue("interactive")
    ).toBe(INTERACTIVE_WORKLOAD_QUEUE);
  });

  it("routes batch workloads to the batch queue", () => {
    expect(
      resolveWorkloadQueue("batch")
    ).toBe(BATCH_WORKLOAD_QUEUE);
  });
});