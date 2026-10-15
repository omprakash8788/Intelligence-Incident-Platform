import {
  describe,
  expect,
  it
} from "vitest";

import {
  buildPipelineFlowDefinition
} from "../src/services/pipeline-flow-builder.js";

import {
  PIPELINE_ANALYZE_QUEUE_NAME,
  PIPELINE_NORMALIZE_QUEUE_NAME,
  PIPELINE_REPORT_QUEUE_NAME
} from "../src/queues/pipeline.queue-names.js";

describe(
  "pipeline flow builder",
  () => {
    it(
      "creates the report -> analyze -> normalize dependency chain",
      () => {
        const definition =
          buildPipelineFlowDefinition(
            "workflow-123",
            "Redis CONNECTION timeout"
          );

        expect(
          definition.queueName
        ).toBe(
          PIPELINE_REPORT_QUEUE_NAME
        );

        expect(
          definition.data
        ).toEqual({
          workflowId: "workflow-123"
        });

        expect(
          definition.children
        ).toHaveLength(1);

        const analyze =
          definition.children[0];

        expect(
          analyze.queueName
        ).toBe(
          PIPELINE_ANALYZE_QUEUE_NAME
        );

        expect(
          analyze.children
        ).toHaveLength(1);

        const normalize =
          analyze.children[0];

        expect(
          normalize.queueName
        ).toBe(
          PIPELINE_NORMALIZE_QUEUE_NAME
        );

        expect(
          normalize.data
        ).toEqual({
          workflowId: "workflow-123",
          originalText:
            "Redis CONNECTION timeout"
        });
      }
    );

    it(
      "configures retries for each stage",
      () => {
        const definition =
          buildPipelineFlowDefinition(
            "workflow-456",
            "Example incident"
          );

        const analyze =
          definition.children[0];

        const normalize =
          analyze.children[0];

        expect(
          definition.opts.attempts
        ).toBe(3);

        expect(
          analyze.opts.attempts
        ).toBe(3);

        expect(
          normalize.opts.attempts
        ).toBe(3);
      }
    );

    it(
      "preserves the workflow ID across all stages",
      () => {
        const definition =
          buildPipelineFlowDefinition(
            "workflow-789",
            "Database failure"
          );

        const analyze =
          definition.children[0];

        const normalize =
          analyze.children[0];

        expect(
          definition.data.workflowId
        ).toBe("workflow-789");

        expect(
          analyze.data.workflowId
        ).toBe("workflow-789");

        expect(
          normalize.data.workflowId
        ).toBe("workflow-789");
      }
    );
  }
);