import {
  FlowProducer,
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  PIPELINE_ANALYZE_QUEUE_NAME,
  PIPELINE_NORMALIZE_QUEUE_NAME,
  PIPELINE_REPORT_QUEUE_NAME
} from "./pipeline.queue-names.js";

import type {
  PipelineAnalyzeData,
  PipelineAnalyzeResult,
  PipelineNormalizeData,
  PipelineNormalizeResult,
  PipelineReportData,
  PipelineReportResult
} from "./jobs/pipeline.job.js";

const defaultJobOptions = {
  attempts: 3,

  backoff: {
    type: "exponential" as const,
    delay: 1000
  },

  removeOnComplete: 100,
  removeOnFail: 500
};

export const pipelineNormalizeQueue =
  new Queue<
    PipelineNormalizeData,
    PipelineNormalizeResult
  >(
    PIPELINE_NORMALIZE_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(1),

      defaultJobOptions
    }
  );

export const pipelineAnalyzeQueue =
  new Queue<
    PipelineAnalyzeData,
    PipelineAnalyzeResult
  >(
    PIPELINE_ANALYZE_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(1),

      defaultJobOptions
    }
  );

export const pipelineReportQueue =
  new Queue<
    PipelineReportData,
    PipelineReportResult
  >(
    PIPELINE_REPORT_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(1),

      defaultJobOptions
    }
  );

export const pipelineFlowProducer =
  new FlowProducer({
    connection:
      createBullMQConnection(1)
  });

export const waitForPipelineQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      pipelineNormalizeQueue.waitUntilReady(),
      pipelineAnalyzeQueue.waitUntilReady(),
      pipelineReportQueue.waitUntilReady(),
      pipelineFlowProducer.waitUntilReady()
    ]);
  };

export const closePipelineQueues =
  async (): Promise<void> => {
    await Promise.all([
      pipelineFlowProducer.close(),
      pipelineNormalizeQueue.close(),
      pipelineAnalyzeQueue.close(),
      pipelineReportQueue.close()
    ]);
  };