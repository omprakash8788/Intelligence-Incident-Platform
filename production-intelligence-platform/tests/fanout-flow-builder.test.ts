import {
  describe,
  expect,
  it
} from "vitest";

import {
  buildFanoutFlowDefinition
} from "../src/services/fanout-flow-builder.js";

import {
  FANOUT_AGGREGATE_QUEUE_NAME,
  FANOUT_TASK_QUEUE_NAME
} from "../src/queues/fanout.queue-names.js";

describe(
  "fanout flow builder",
  () => {
    it(
      "creates one parent and one child per input item",
      () => {
        const definition =
          buildFanoutFlowDefinition(
            "workflow-123",
            [
              {
                itemId: "item-1",
                value: "database unavailable"
              },
              {
                itemId: "item-2",
                value: "redis timeout"
              },
              {
                itemId: "item-3",
                value: "worker stalled"
              }
            ]
          );

        expect(
          definition.queueName
        ).toBe(
          FANOUT_AGGREGATE_QUEUE_NAME
        );

        expect(
          definition.data
        ).toEqual({
          workflowId: "workflow-123",
          expectedChildren: 3
        });

        expect(
          definition.children
        ).toHaveLength(3);

        expect(
          definition.children.map(
            (child) => child.queueName
          )
        ).toEqual([
          FANOUT_TASK_QUEUE_NAME,
          FANOUT_TASK_QUEUE_NAME,
          FANOUT_TASK_QUEUE_NAME
        ]);
      }
    );

    it(
      "preserves each child's input and workflow ID",
      () => {
        const definition =
          buildFanoutFlowDefinition(
            "workflow-456",
            [
              {
                itemId: "item-a",
                value: "database"
              },
              {
                itemId: "item-b",
                value: "redis"
              }
            ]
          );

        expect(
          definition.children.map(
            (child) => child.data
          )
        ).toEqual([
          {
            workflowId: "workflow-456",
            itemId: "item-a",
            value: "database"
          },
          {
            workflowId: "workflow-456",
            itemId: "item-b",
            value: "redis"
          }
        ]);

        expect(
          definition.data.expectedChildren
        ).toBe(2);
      }
    );

    it(
      "configures retries for the parent and children",
      () => {
        const definition =
          buildFanoutFlowDefinition(
            "workflow-789",
            [
              {
                itemId: "item-1",
                value: "incident"
              }
            ]
          );

        expect(
          definition.opts.attempts
        ).toBe(3);

        expect(
          definition.children[0].opts.attempts
        ).toBe(3);

        expect(
          definition.opts.backoff
        ).toEqual({
          type: "exponential",
          delay: 1000
        });
      }
    );
  }
);