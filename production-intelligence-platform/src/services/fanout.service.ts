import {
  randomUUID
} from "node:crypto";

import {
  fanoutFlowProducer
} from "../queues/fanout.queues.js";

import {
  buildFanoutFlowDefinition
} from "./fanout-flow-builder.js";

export const createFanoutWorkflow =
  async (
    values: string[]
  ) => {
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 10
    ) {
      throw new Error(
        "Fan-out requires between 1 and 10 items"
      );
    }

    if (
      values.some(
        (value) =>
          typeof value !== "string" ||
          value.trim().length === 0 ||
          value.length > 500
      )
    ) {
      throw new Error(
        "Every fan-out item must be a non-empty string of at most 500 characters"
      );
    }

    const workflowId = randomUUID();

    const items = values.map((value) => ({
      itemId: randomUUID(),
      value: value.trim()
    }));

    const definition =
      buildFanoutFlowDefinition(
        workflowId,
        items
      );

    const flow =
      await fanoutFlowProducer.add(
        definition
      );

    if (flow.job.id === undefined) {
      throw new Error(
        "BullMQ did not return a parent job ID"
      );
    }

    return {
      workflowId,
      parentJobId: String(flow.job.id),
      childCount: items.length
    };
  };