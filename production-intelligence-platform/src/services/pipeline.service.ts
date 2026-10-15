import {
  randomUUID
} from "node:crypto";

import {
  pipelineFlowProducer
} from "../queues/pipeline.queues.js";

import {
  buildPipelineFlowDefinition
} from "./pipeline-flow-builder.js";

export const createPipelineWorkflow =
  async (
    originalText: string
  ) => {
    if (
      typeof originalText !== "string" ||
      originalText.trim().length === 0 ||
      originalText.length > 2000
    ) {
      throw new Error(
        "text must be a non-empty string of at most 2000 characters"
      );
    }

    const workflowId = randomUUID();

    const definition =
      buildPipelineFlowDefinition(
        workflowId,
        originalText
      );

    const flow =
      await pipelineFlowProducer.add(
        definition
      );

    if (flow.job.id === undefined) {
      throw new Error(
        "BullMQ did not return a report job ID"
      );
    }

    return {
      workflowId,
      parentJobId: String(flow.job.id)
    };
  };

