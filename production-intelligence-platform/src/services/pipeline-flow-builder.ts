import {
  PIPELINE_ANALYZE_QUEUE_NAME,
  PIPELINE_NORMALIZE_QUEUE_NAME,
  PIPELINE_REPORT_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineNormalizeData
} from "../queues/jobs/pipeline.job.js";

export const buildPipelineFlowDefinition = (
  workflowId: string,
  originalText: string
) => {
  const normalizeData: PipelineNormalizeData = {
    workflowId,
    originalText
  };

  return {
    name: "generate-report",

    queueName:
      PIPELINE_REPORT_QUEUE_NAME,

    data: {
      workflowId
    },

    opts: {
      attempts: 3,

      backoff: {
        type: "exponential" as const,
        delay: 1000
      }
    },

    children: [
      {
        name: "analyze-text",

        queueName:
          PIPELINE_ANALYZE_QUEUE_NAME,

        data: {
          workflowId
        },

        opts: {
          attempts: 3,

          backoff: {
            type: "exponential" as const,
            delay: 1000
          }
        },

        children: [
          {
            name: "normalize-text",

            queueName:
              PIPELINE_NORMALIZE_QUEUE_NAME,

            data: normalizeData,

            opts: {
              attempts: 3,

              backoff: {
                type: "exponential" as const,
                delay: 1000
              }
            }
          }
        ]
      }
    ]
  };
};