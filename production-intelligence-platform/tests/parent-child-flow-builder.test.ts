import {
  describe,
  expect,
  it
} from "vitest";

import {
  buildParentChildFlow
} from "../src/services/parent-child-flow-builder.js";

import {
  PARENT_CHILD_ITEM_QUEUE,
  PARENT_CHILD_PARENT_QUEUE
} from "../src/queues/parent-child.queue-names.js";

describe("buildParentChildFlow", () => {
  it("creates a parent with one child per input", () => {
    const flow = buildParentChildFlow(
      "batch-123",
      [
        "Redis",
        "PostgreSQL",
        "API Gateway"
      ]
    );

    expect(flow.queueName).toBe(
      PARENT_CHILD_PARENT_QUEUE
    );

    expect(flow.name).toBe("aggregate-batch");

    expect(flow.data).toEqual({
      batchId: "batch-123",
      itemCount: 3
    });

    expect(flow.children).toHaveLength(3);

    expect(flow.children?.map(
      (child) => child.queueName
    )).toEqual([
      PARENT_CHILD_ITEM_QUEUE,
      PARENT_CHILD_ITEM_QUEUE,
      PARENT_CHILD_ITEM_QUEUE
    ]);
  });

  it("preserves the original input index", () => {
    const flow = buildParentChildFlow(
      "batch-456",
      [
        "Redis",
        "PostgreSQL"
      ]
    );

    expect(flow.children?.map(
      (child) => child.data
    )).toEqual([
      {
        batchId: "batch-456",
        index: 0,
        value: "Redis"
      },
      {
        batchId: "batch-456",
        index: 1,
        value: "PostgreSQL"
      }
    ]);
  });

  it("creates no children for an empty input", () => {
    const flow = buildParentChildFlow(
      "batch-empty",
      []
    );

    expect(flow.children).toEqual([]);

    expect(flow.data).toEqual({
      batchId: "batch-empty",
      itemCount: 0
    });
  });

  it("configures retries for parent and child jobs", () => {
    const flow = buildParentChildFlow(
      "batch-retry",
      ["Redis"]
    );

    expect(flow.opts).toEqual({
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      }
    });

    expect(flow.children?.[0].opts).toEqual({
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      }
    });
  });
});