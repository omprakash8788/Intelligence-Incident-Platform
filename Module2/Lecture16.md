# Module 2 — Lecture 16: Job Pipelines & Dependencies

**Project:** Production Intelligence & Incident Platform  
**Stack:** Node.js, TypeScript, Express, BullMQ, Redis, Docker  
**Prerequisite:** Module 2, Lectures 13–15

---

## Table of Contents

1. Learning objectives
2. Understand job pipelines
3. Pipeline architecture
4. Create job contracts
5. Create queue names and queue resources
6. Build the pipeline definition
7. Create the pipeline service
8. Implement Stage 1
9. Implement Stage 2
10. Implement Stage 3
11. Create the API routes
12. Register the routes
13. Integrate worker lifecycle management
14. Add unit tests
15. Build and start the application
16. Test the complete pipeline
17. Break the pipeline intentionally
18. Fix and verify
19. Production engineering considerations
20. Final folder structure
21. Completion checklist

---

# 1. Learning Objectives

By the end of this lecture, you will understand:

- What a job pipeline is.
- How a pipeline differs from fan-out/fan-in.
- How to create dependent jobs using BullMQ `FlowProducer`.
- How to execute sequential stages across separate queues.
- How to pass results between stages using BullMQ child dependencies.
- How to retry failed stages.
- How to inspect pipeline status.
- How to test pipeline construction without Redis.
- How to reproduce a downstream-stage failure and fix it.
- Why retries, idempotency, result retention, and durable state matter in production.

We will implement a three-stage processing pipeline.

The example simulates processing an incident description:

1. **Normalize:** Clean the input text.
2. **Analyze:** Calculate word and character counts.
3. **Report:** Produce a final structured result.

This is deterministic processing. We will not integrate AI.

## What we will build

Endpoint:

`POST /demo/pipelines`

Example request:

```json
{
  "text": "  Redis CONNECTION timeout  "
}
```

Expected final output will include:

- The original text.
- The normalized text.
- The word count.
- The character count.
- The pipeline workflow ID.
- A completion timestamp.

---

# 2. Understand Job Pipelines

A job pipeline consists of stages that execute in a defined dependency order.

Consider a production incident:

```text
Raw incident event
        |
        v
Normalize event
        |
        v
Analyze event
        |
        v
Generate report
        |
        v
Final result
```

Stage 2 cannot execute until Stage 1 completes successfully. Stage 3 cannot execute until Stage 2 completes successfully.

This is different from independent jobs that can all start immediately.

## 2.1 Pipeline versus fan-out/fan-in

| Property | Pipeline | Fan-out/fan-in |
|---|---|---|
| Execution model | Sequential dependencies | Parallel child tasks followed by aggregation |
| Example | Normalize → analyze → report | Analyze 10 independent records → combine |
| Dependency | Each stage depends on the preceding stage | Parent depends on multiple children |
| Main challenge | Correct stage ordering and failure recovery | Coordinating parallel results and partial failures |
| BullMQ mechanism | Nested job flows | Parent-child flows |

A system can combine both patterns. For example, one pipeline stage may fan out into 100 independent jobs, then aggregate them before the next pipeline stage.

## 2.2 Why separate queues?

We will use three queues:

- `pipeline-normalize`
- `pipeline-analyze`
- `pipeline-report`

Each stage has its own worker.

This lets us configure each stage independently. For example, analysis may need more concurrency than report generation.

Separate queues also allow independent monitoring and operational controls.

---

# 3. Pipeline Architecture

We will use BullMQ's `FlowProducer` to construct the dependency graph.

The important detail is that BullMQ flow trees are represented from the root parent down to its children. For a sequential pipeline, the final stage is the root parent, and the earlier stages are nested beneath it.

```text
                    Express API
                         |
                         v
                   Pipeline Service
                         |
                         v
                    FlowProducer
                         |
                         v
                  Stage 3: Report
                         |
                  waits for Stage 2
                         |
                         v
                  Stage 2: Analyze
                         |
                  waits for Stage 1
                         |
                         v
                 Stage 1: Normalize
```

Execution happens in the reverse direction of the tree:

1. Stage 1 becomes eligible.
2. Stage 1 completes and stores its result.
3. Stage 2 becomes eligible and reads Stage 1's result.
4. Stage 2 completes and stores its result.
5. Stage 3 becomes eligible and reads Stage 2's result.
6. Stage 3 produces the final report.

BullMQ manages the dependency state in Redis.

Official documentation: https://docs.bullmq.io/guide/flows

---

# 4. Create Job Contracts

### File: `src/queues/jobs/pipeline.job.ts`

**Action:** Create this file.

```ts
export interface PipelineNormalizeData {
  workflowId: string;
  originalText: string;
}

export interface PipelineNormalizeResult {
  workflowId: string;
  originalText: string;
  normalizedText: string;
}

export interface PipelineAnalyzeData {
  workflowId: string;
}

export interface PipelineAnalyzeResult {
  workflowId: string;
  originalText: string;
  normalizedText: string;
  wordCount: number;
  characterCount: number;
}

export interface PipelineReportData {
  workflowId: string;
}

export interface PipelineReportResult {
  workflowId: string;
  originalText: string;
  normalizedText: string;
  wordCount: number;
  characterCount: number;
  status: "completed";
  completedAt: string;
}
```

## Explanation

The first stage receives the original text.

The second stage receives the workflow ID. It obtains the normalized result through its child dependency.

The third stage also receives the workflow ID and reads the analysis result through its child dependency.

This design demonstrates how results can flow between dependent jobs without placing every intermediate value into the initial API request.

**Important:** TypeScript types are compile-time contracts. We will also validate child results at runtime because Redis-stored job data is runtime data.

---

# 5. Create Queue Names and Queue Resources

## 5.1 Queue names

### File: `src/queues/pipeline.queue-names.ts`

**Action:** Create this file.

```ts
export const PIPELINE_NORMALIZE_QUEUE_NAME =
  "pipeline-normalize";

export const PIPELINE_ANALYZE_QUEUE_NAME =
  "pipeline-analyze";

export const PIPELINE_REPORT_QUEUE_NAME =
  "pipeline-report";
```

Centralizing queue names reduces the risk of spelling inconsistencies between producers and workers.

## 5.2 Queue resources

### File: `src/queues/pipeline.queues.ts`

**Action:** Create this file.

```ts
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
```

## Why have a separate queue per stage?

Each stage can have its own:

- Worker concurrency.
- Retry policy.
- Backoff settings.
- Queue metrics.
- Operational capacity.

We use the same default retry configuration for this exercise. A real application should tune each stage based on its failure characteristics.

## Why use `FlowProducer`?

We want the dependencies to exist before the parent is eligible to run.

The flow producer creates the complete dependency structure, instead of relying on the API to enqueue jobs in a sequence that could be interrupted by a process crash.

---

# 6. Build the Pipeline Definition

We will keep pipeline construction separate from the Redis submission operation. This makes the dependency graph easy to unit-test.

### File: `src/services/pipeline-flow-builder.ts`

**Action:** Create this file.

```ts
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
```

## Understand the nested structure

The root is the report job.

The report job has the analysis job as a child.

The analysis job has the normalization job as a child.

Although the tree is written from the final stage toward the first stage, BullMQ's dependency mechanism makes the first stage eligible to run first.

This is the key idea behind representing sequential pipelines with nested flows.

---

# 7. Create the Pipeline Service

### File: `src/services/pipeline.service.ts`

**Action:** Create this file.

```ts
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
```

## Why is the report job the parent?

The report job represents the overall pipeline result.

It cannot run until the analysis job completes.

The analysis job cannot run until normalization completes.

Therefore, the report job's state provides a useful top-level indicator of pipeline progress.

The service returns the root job ID, which clients can use to inspect the overall workflow.

---

# 8. Implement Stage 1 — Normalize

### File: `src/workers/pipeline-normalize.worker.ts`

**Action:** Create this file.

```ts
import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PIPELINE_NORMALIZE_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineNormalizeData,
  PipelineNormalizeResult
} from "../queues/jobs/pipeline.job.js";

import {
  logger
} from "../logging/logger.js";

export const pipelineNormalizeWorker =
  new Worker<
    PipelineNormalizeData,
    PipelineNormalizeResult
  >(
    PIPELINE_NORMALIZE_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Pipeline normalization started",
        {
          queue:
            PIPELINE_NORMALIZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      const normalizedText =
        job.data.originalText
          .trim()
          .replace(/\s+/g, " ")
          .toLowerCase();

      const result: PipelineNormalizeResult = {
        workflowId:
          job.data.workflowId,

        originalText:
          job.data.originalText,

        normalizedText
      };

      logger.info(
        "Pipeline normalization completed",
        {
          queue:
            PIPELINE_NORMALIZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      return result;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 5
    }
  );

pipelineNormalizeWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Pipeline normalization failed",
      {
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

pipelineNormalizeWorker.on(
  "error",
  (error) => {
    logger.error(
      "Pipeline normalization worker error",
      {
        error: error.message
      }
    );
  }
);
```

## What does Stage 1 do?

It:

1. Trims leading and trailing whitespace.
2. Replaces repeated whitespace with a single space.
3. Converts the text to lowercase.
4. Returns the original and normalized text.

Example:

```text
Input:
"  Redis   CONNECTION timeout  "

Output:
"redis connection timeout"
```

The result is stored by BullMQ as the completed job's return value.

Stage 2 will retrieve this result through its dependency.

---

# 9. Implement Stage 2 — Analyze

### File: `src/workers/pipeline-analyze.worker.ts`

**Action:** Create this file.

```ts
import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PIPELINE_ANALYZE_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineAnalyzeData,
  PipelineAnalyzeResult,
  PipelineNormalizeResult
} from "../queues/jobs/pipeline.job.js";

import {
  logger
} from "../logging/logger.js";

const isPipelineNormalizeResult = (
  value: unknown
): value is PipelineNormalizeResult => {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const result =
    value as Record<string, unknown>;

  return (
    typeof result.workflowId === "string" &&
    typeof result.originalText === "string" &&
    typeof result.normalizedText === "string"
  );
};

export const pipelineAnalyzeWorker =
  new Worker<
    PipelineAnalyzeData,
    PipelineAnalyzeResult
  >(
    PIPELINE_ANALYZE_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Pipeline analysis started",
        {
          queue:
            PIPELINE_ANALYZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      const childValues =
        await job.getChildrenValues();

      const results: unknown[] =
        Object.values(childValues);

      if (results.length !== 1) {
        throw new Error(
          `Expected one normalization result, received ${results.length}`
        );
      }

      const normalizedResult =
        results.find(
          isPipelineNormalizeResult
        );

      if (!normalizedResult) {
        throw new Error(
          "Normalization result is invalid"
        );
      }

      if (
        normalizedResult.workflowId !==
        job.data.workflowId
      ) {
        throw new Error(
          "Normalization result belongs to another workflow"
        );
      }

      const normalizedText =
        normalizedResult.normalizedText;

      const wordCount =
        normalizedText.length === 0
          ? 0
          : normalizedText.split(/\s+/).length;

      const result: PipelineAnalyzeResult = {
        workflowId:
          job.data.workflowId,

        originalText:
          normalizedResult.originalText,

        normalizedText,

        wordCount,

        characterCount:
          normalizedText.length
      };

      logger.info(
        "Pipeline analysis completed",
        {
          queue:
            PIPELINE_ANALYZE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          wordCount,
          characterCount:
            result.characterCount
        }
      );

      return result;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 5
    }
  );

pipelineAnalyzeWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Pipeline analysis failed",
      {
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

pipelineAnalyzeWorker.on(
  "error",
  (error) => {
    logger.error(
      "Pipeline analysis worker error",
      {
        error: error.message
      }
    );
  }
);
```

## How Stage 2 retrieves the previous result

The important operation is:

```ts
const childValues =
  await job.getChildrenValues();
```

BullMQ returns the results of the completed child jobs.

The worker then validates the result before using it.

This is necessary because a TypeScript interface does not validate Redis-stored data at runtime.

## Why calculate both counts?

The word count and character count demonstrate a simple deterministic analysis stage.

For the normalized input:

```text
redis connection timeout
```

The expected results are:

- Word count: `3`
- Character count: `24`

The character count includes spaces but does not include the original leading or trailing whitespace because Stage 1 normalized the text first.

---

# 10. Implement Stage 3 — Generate the Report

### File: `src/workers/pipeline-report.worker.ts`

**Action:** Create this file.

```ts
import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PIPELINE_REPORT_QUEUE_NAME
} from "../queues/pipeline.queue-names.js";

import type {
  PipelineAnalyzeResult,
  PipelineReportData,
  PipelineReportResult
} from "../queues/jobs/pipeline.job.js";

import {
  logger
} from "../logging/logger.js";

const isPipelineAnalyzeResult = (
  value: unknown
): value is PipelineAnalyzeResult => {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return false;
  }

  const result =
    value as Record<string, unknown>;

  return (
    typeof result.workflowId === "string" &&
    typeof result.originalText === "string" &&
    typeof result.normalizedText === "string" &&
    typeof result.wordCount === "number" &&
    typeof result.characterCount === "number"
  );
};

export const pipelineReportWorker =
  new Worker<
    PipelineReportData,
    PipelineReportResult
  >(
    PIPELINE_REPORT_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Pipeline report generation started",
        {
          queue:
            PIPELINE_REPORT_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      const childValues =
        await job.getChildrenValues();

      const results: unknown[] =
        Object.values(childValues);

      if (results.length !== 1) {
        throw new Error(
          `Expected one analysis result, received ${results.length}`
        );
      }

      const analysisResult =
        results.find(
          isPipelineAnalyzeResult
        );

      if (!analysisResult) {
        throw new Error(
          "Analysis result is invalid"
        );
      }

      if (
        analysisResult.workflowId !==
        job.data.workflowId
      ) {
        throw new Error(
          "Analysis result belongs to another workflow"
        );
      }

      if (
        !Number.isInteger(
          analysisResult.wordCount
        ) ||
        analysisResult.wordCount < 0 ||
        !Number.isInteger(
          analysisResult.characterCount
        ) ||
        analysisResult.characterCount < 0
      ) {
        throw new Error(
          "Analysis result contains invalid counts"
        );
      }

      const result: PipelineReportResult = {
        workflowId:
          job.data.workflowId,

        originalText:
          analysisResult.originalText,

        normalizedText:
          analysisResult.normalizedText,

        wordCount:
          analysisResult.wordCount,

        characterCount:
          analysisResult.characterCount,

        status: "completed",

        completedAt:
          new Date().toISOString()
      };

      logger.info(
        "Pipeline report generation completed",
        {
          queue:
            PIPELINE_REPORT_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId
        }
      );

      return result;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 2
    }
  );

pipelineReportWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Pipeline report generation failed",
      {
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

pipelineReportWorker.on(
  "error",
  (error) => {
    logger.error(
      "Pipeline report worker error",
      {
        error: error.message
      }
    );
  }
);
```

## What happens here?

The report worker:

1. Reads the completed analysis result.
2. Verifies its shape.
3. Confirms the workflow ID matches.
4. Validates the calculated counts.
5. Returns the final report.

If the result is invalid, the worker throws an error.

BullMQ applies the configured retry policy to the report job.

**Important:** A retry is useful only when repeating the operation may succeed. A deterministic validation error will generally fail again until the underlying problem is corrected.

---

# 11. Create the API Routes

We will expose:

- `POST /demo/pipelines` — submit a pipeline.
- `GET /demo/pipelines/:parentJobId` — inspect pipeline status and its final result.

### File: `src/routes/pipeline.routes.ts`

**Action:** Create this file.

```ts
import {
  Router
} from "express";

import {
  pipelineReportQueue
} from "../queues/pipeline.queues.js";

import {
  createPipelineWorkflow
} from "../services/pipeline.service.js";

const router = Router();

router.post(
  "/demo/pipelines",
  async (req, res, next) => {
    try {
      const body: unknown =
        req.body;

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_REQUEST_BODY",
            message:
              "Request body must be a JSON object"
          }
        });

        return;
      }

      const requestBody =
        body as Record<
          string,
          unknown
        >;

      const text =
        requestBody.text;

      if (
        typeof text !== "string" ||
        text.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_TEXT",
            message:
              "text must be a non-empty string"
          }
        });

        return;
      }

      if (text.length > 2000) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "TEXT_TOO_LONG",
            message:
              "text must not exceed 2000 characters"
          }
        });

        return;
      }

      const workflow =
        await createPipelineWorkflow(
          text
        );

      res.status(202).json({
        success: true,
        data: workflow
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/demo/pipelines/:parentJobId",
  async (req, res, next) => {
    try {
      const parentJobId =
        req.params.parentJobId;

      const job =
        await pipelineReportQueue.getJob(
          parentJobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "PIPELINE_NOT_FOUND",
            message:
              "The pipeline was not found"
          }
        });

        return;
      }

      const state =
        await job.getState();

      res.status(200).json({
        success: true,
        data: {
          parentJobId,
          workflowId:
            job.data.workflowId,
          state,

          ...(state === "completed"
            ? {
                result:
                  job.returnvalue
              }
            : {}),

          ...(state === "failed"
            ? {
                failedReason:
                  job.failedReason
              }
            : {})
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

## Why return HTTP 202?

The API accepts the pipeline for asynchronous processing.

It does not wait for all three stages to complete before responding.

The client receives the root parent job ID and can use it to inspect the final state.

## What does the status endpoint show?

The root report job represents the pipeline's overall state.

Depending on the timing, the state may be:

- `waiting-children`
- `waiting`
- `active`
- `completed`
- `failed`

A status response is a snapshot. The state can change immediately afterward.

---

# 12. Register the Routes

### File: `src/app.ts`

**Action:** Add this import alongside your existing route imports.

```ts
import pipelineRoutes
  from "./routes/pipeline.routes.js";
```

**Action:** Register the router with your other application routes.

```ts
app.use(pipelineRoutes);
```

Register it before your not-found and error middleware.

Preserve your existing security middleware, request ID middleware, logging, health routes, incident routes, monitoring routes, and all previous lecture routes.

**Do not replace the entire `app.ts` file.**

---

# 13. Integrate Worker Lifecycle Management

The three new workers and the pipeline queues must participate in the existing worker lifecycle.

### File: `src/workers.ts`

**Action 1:** Add these imports alongside the existing worker imports.

```ts
import {
  pipelineNormalizeWorker
} from "./workers/pipeline-normalize.worker.js";

import {
  pipelineAnalyzeWorker
} from "./workers/pipeline-analyze.worker.js";

import {
  pipelineReportWorker
} from "./workers/pipeline-report.worker.js";

import {
  closePipelineQueues,
  waitForPipelineQueuesReady
} from "./queues/pipeline.queues.js";
```

## 13.1 Startup changes

Inside your existing `start()` function, after the existing readiness checks, add:

```ts
await waitForPipelineQueuesReady();

await Promise.all([
  pipelineNormalizeWorker.waitUntilReady(),
  pipelineAnalyzeWorker.waitUntilReady(),
  pipelineReportWorker.waitUntilReady()
]);
```

Keep the existing demo worker, external API worker, QueueEvents, and fan-out worker initialization.

Do not add duplicate readiness checks.

## 13.2 Shutdown changes

Inside your existing `shutdown()` function, close the new workers before closing their queue resources.

Add the following operations to the existing shutdown sequence:

```ts
await Promise.all([
  pipelineNormalizeWorker.close(),
  pipelineAnalyzeWorker.close(),
  pipelineReportWorker.close()
]);

await closePipelineQueues();
```

The intended order is:

1. Stop the existing workers.
2. Stop the fan-out workers.
3. Stop the pipeline workers.
4. Close the existing QueueEvents listener.
5. Close fan-out queue resources.
6. Close pipeline queue resources.
7. Log shutdown completion.

Retain your existing idempotent shutdown guard and SIGINT/SIGTERM handlers.

## 13.3 Startup failure cleanup

Your existing worker startup failure handler should also close any pipeline workers and pipeline queue resources that were initialized before startup failed.

Integrate these into the existing `Promise.allSettled()` cleanup:

```ts
pipelineNormalizeWorker.close(),
pipelineAnalyzeWorker.close(),
pipelineReportWorker.close(),
closePipelineQueues()
```

#### Add like this
```
  await Promise.allSettled([
      // Existing workers
      demoWorker.close(),
      externalApiWorker.close(),

      // Fan-out workers
      fanoutTaskWorker.close(),
      fanoutAggregateWorker.close(),

      // Pipeline workers
      pipelineNormalizeWorker.close(),
      pipelineAnalyzeWorker.close(),
      pipelineReportWorker.close(),

      // Queue resources
      closeDemoQueueEvents(),
      closeFanoutQueues(),
      closePipelineQueues()
    ]);
```

Also retain the existing cleanup operations for the demo worker, external API worker, QueueEvents, and fan-out resources.

Do not create a second signal handler or replace the entire `workers.ts` file.

**Important:** Startup failure cleanup and graceful shutdown cleanup are separate paths. Both must release the resources they own.

---

# 14. Add Unit Tests

We will test the pipeline's dependency graph without Redis.

### File: `tests/pipeline-flow-builder.test.ts`

**Action:** Create this file.

```ts
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
```

## What do these tests prove?

They verify that:

- The report queue is the root.
- The analysis queue is its child.
- The normalization queue is nested under analysis.
- The workflow ID is preserved across the stages.
- Every stage has retry configuration.

These tests validate the flow definition. They do not prove that Redis executes the flow correctly. That requires the runtime tests below.

---

# 15. Build and Start the Application

Open PowerShell.

## Step 1: Navigate to your project

```powershell
cd D:\Production-Intelligence-Incident-Platform\production-intelligence-platform
```

## Step 2: Build

```powershell
npm run build

docker compose build api

docker compose up -d --force-recreate api
```

Expected result: TypeScript compilation succeeds.

If the build fails, fix the reported error before continuing.

## Step 3: Run unit tests

```powershell
npm run test:run
```

Expected result: the three new pipeline flow-builder tests pass, along with your existing tests.

## Step 4: Start dependencies

```powershell
docker compose up -d postgres redis
```

Verify:

```powershell
docker compose ps
```

PostgreSQL remains part of your application, although the pipeline implementation in this lecture uses Redis and BullMQ directly.

## Step 5: Start the API

Terminal 1:

```powershell
npm run dev
```

## Step 6: Start the worker process

Terminal 2:

```powershell
npm run dev:worker
```

Confirm that all three pipeline workers become ready:

- `pipeline-normalize`
- `pipeline-analyze`
- `pipeline-report`

Also confirm that your existing demo, external API, and fan-out workers still start correctly.

---

# 16. Test the Complete Pipeline

## Test A: Submit a pipeline

Run in PowerShell:

```powershell
$body = @{
  text = "  Redis   CONNECTION timeout  "
} | ConvertTo-Json

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/pipelines" `
  -ContentType "application/json" `
  -Body $body

$response | ConvertTo-Json -Depth 10
```

Expected result:

- HTTP 202.
- `success` is `true`.
- A `workflowId` is returned.
- A `parentJobId` is returned.

Save the parent job ID:

```powershell
$parentJobId = $response.data.parentJobId
```

## Test B: Inspect the pipeline

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/demo/pipelines/$parentJobId" |
  ConvertTo-Json -Depth 10
```

The initial state may be `waiting-children`. The state may also advance before you inspect it.

## Test C: Poll until completion

```powershell
do {
  $status = Invoke-RestMethod `
    -Method Get `
    -Uri "http://localhost:3000/demo/pipelines/$parentJobId"

  Write-Host "Pipeline state:" $status.data.state

  if (
    $status.data.state -eq "completed" -or
    $status.data.state -eq "failed"
  ) {
    break
  }

  Start-Sleep -Seconds 1
} while ($true)

$status | ConvertTo-Json -Depth 10
```

Expected final state:

```text
completed
```

The final result should contain values equivalent to:

```json
{
  "workflowId": "...",
  "originalText": "  Redis   CONNECTION timeout  ",
  "normalizedText": "redis connection timeout",
  "wordCount": 3,
  "characterCount": 24,
  "status": "completed",
  "completedAt": "..."
}
```

The workflow ID and timestamp will differ for every run.

## Test D: Verify execution order

Inspect the worker terminal.

The expected order is:

1. Pipeline normalization starts.
2. Pipeline normalization completes.
3. Pipeline analysis starts.
4. Pipeline analysis completes.
5. Pipeline report generation starts.
6. Pipeline report generation completes.

The exact timestamps depend on scheduling. The important requirement is that a dependent stage does not start before its child dependency completes.

## Test E: Reject invalid input

```powershell
$body = @{
  text = "   "
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/pipelines" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_TEXT`.

## Test F: Reject oversized input

```powershell
$body = @{
  text = "x" * 2001
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/pipelines" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `TEXT_TOO_LONG`.

PowerShell may display an exception for these non-2xx responses. That is expected.

---

# 17. Break the Pipeline Intentionally

We will introduce a bug in Stage 2's output.

The goal is to see how a downstream stage detects invalid data.

## Break A: Return an invalid word count

### File: `src/workers/pipeline-analyze.worker.ts`

**Action:** Temporarily replace this line:

```ts
wordCount,
```

with:

```ts
wordCount: -1,
```

This deliberately violates the contract that a word count must be a non-negative integer.

Save the file and restart the worker process so the modified code is loaded.

## Test the broken implementation

Build:

```powershell
npm run build
```

Submit a new pipeline using Test A.

Poll the root job using Test C.

Expected behavior:

1. Normalization completes successfully.
2. Analysis completes but returns an invalid word count.
3. The report stage becomes eligible.
4. The report worker rejects the invalid count.
5. BullMQ retries the report job according to its configured policy.
6. The report job eventually enters `failed` if every attempt produces the same invalid result.

The retry backoff means the terminal failure may take several seconds.

## Root-cause analysis

The dependency mechanism worked correctly. Each stage ran in the expected order.

The defect was a data-contract violation between Stage 2 and Stage 3.

The report worker correctly rejected the invalid value instead of publishing a misleading final result.

This is an important production principle:

**Successful execution of an upstream stage does not guarantee that its output is semantically correct.**

Downstream stages should validate critical invariants before using upstream results.

---

# 18. Fix and Verify

### File: `src/workers/pipeline-analyze.worker.ts`

**Action:** Restore the correct output.

Replace:

```ts
wordCount: -1,
```

with:

```ts
wordCount,
```

Run the build:

```powershell
npm run build
```

Run the tests:

```powershell
npm run test:run
```

Restart the worker process.

Submit a **new pipeline** using Test A and poll its status using Test C.

Expected final state:

```text
completed
```

The final report should contain:

- `normalizedText`: `redis connection timeout`
- `wordCount`: `3`
- `characterCount`: `24`
- `status`: `completed`

Do not expect the previously failed workflow to repair itself automatically after changing the source code. Its retries may already be exhausted. Submit a new workflow to verify the fix.

## Final verification checklist

- [ ] TypeScript build succeeds.
- [ ] Unit tests pass.
- [ ] The API accepts valid input.
- [ ] Invalid and oversized input is rejected.
- [ ] Stage 1 completes before Stage 2.
- [ ] Stage 2 completes before Stage 3.
- [ ] The final report contains the correct counts.
- [ ] The broken word count causes report validation to fail.
- [ ] The corrected implementation completes a new workflow.
- [ ] Existing queues and workers still start and shut down correctly.

---

# 19. Production Engineering Considerations

## 19.1 Retries do not repair deterministic bugs

The report worker will retry a validation error if its retry policy allows it.

However, if Stage 2 always produces `wordCount: -1`, every report attempt will receive the same invalid value.

Retries are most useful for transient failures such as temporary network problems. They do not correct deterministic logic errors.

## 19.2 Child failure and parent behavior

In BullMQ flows, a parent normally waits for its dependencies to complete.

If a child exhausts its retries and fails, the parent does not simply proceed as if the child succeeded. Depending on the dependency-failure configuration, the parent can remain blocked until the failure is handled.

A production workflow must define a policy for failed stages:

- Retry transient errors.
- Fail the workflow for required-stage failures.
- Support controlled recovery.
- Allow partial results only when the business rules explicitly permit them.

Do not assume that every child failure automatically produces a clean terminal failure for the entire workflow.

## 19.3 Idempotency

Workers can execute jobs more than once because of retries or process failures.

If Stage 3 sends an external notification, a retry could send the notification again unless the operation is idempotent.

Use stable operation identifiers, provider-supported idempotency keys, and durable state where necessary.

## 19.4 Result retention

This implementation uses bounded completed-job retention.

That is useful for demonstrations and operational control, but BullMQ job results are not a permanent business database.

For workflows requiring long-term audit history, store the final business result and lifecycle events in PostgreSQL.

## 19.5 Queue separation

Separate queues allow each stage to have independent concurrency and monitoring.

However, they still share Redis and may share CPU, memory, and network capacity.

A Redis outage can affect every queue using that Redis instance. Queue separation alone is not complete fault isolation.

## 19.6 Pipeline status versus business status

The root job state reports BullMQ processing status.

A real production platform may also need a durable business workflow state such as:

- `accepted`
- `processing`
- `completed`
- `failed`
- `cancelled`

Do not assume BullMQ's internal state alone is sufficient for audit, customer-facing status, or long-term reporting.

## 19.7 Database and Redis consistency

Suppose the application records an incident in PostgreSQL and then submits a pipeline to Redis.

If the database transaction succeeds but Redis enqueueing fails, the incident may exist without a corresponding workflow.

This is a dual-write consistency problem. A transactional outbox is a common solution and will be covered in the distributed-systems module.

## 19.8 Graceful shutdown

The worker process must close the three pipeline workers before closing the queue resources.

The startup failure path must also clean up partially initialized resources.

Verify both normal shutdown and startup failure behavior rather than checking only whether the application starts.

---

# 20. Final Folder Structure

The new files introduced in this lecture are:

```text
src/
├── queues/
│   ├── pipeline.queue-names.ts
│   ├── pipeline.queues.ts
│   └── jobs/
│       └── pipeline.job.ts
├── services/
│   ├── pipeline-flow-builder.ts
│   └── pipeline.service.ts
├── workers/
│   ├── pipeline-normalize.worker.ts
│   ├── pipeline-analyze.worker.ts
│   └── pipeline-report.worker.ts
├── routes/
│   └── pipeline.routes.ts
├── app.ts
└── workers.ts

tests/
└── pipeline-flow-builder.test.ts
```

This is the relevant part of your project, not a replacement for the existing directory structure.

Your demo queue, external API queue, fan-out queues, monitoring routes, configuration, middleware, and existing workers should remain intact.

---

# 21. Completion Checklist

Before moving to Lecture 17, confirm:

- [ ] I understand sequential pipelines and dependencies.
- [ ] I understand the difference between pipelines and fan-out/fan-in.
- [ ] I created the job contracts.
- [ ] I created three separate pipeline queues.
- [ ] I created the nested flow definition.
- [ ] I created the pipeline service.
- [ ] I implemented the normalization worker.
- [ ] I implemented the analysis worker.
- [ ] I implemented the report worker.
- [ ] I created and registered the API routes.
- [ ] I integrated worker readiness and shutdown.
- [ ] I added and passed the flow-builder unit tests.
- [ ] I submitted a pipeline and retrieved its final result.
- [ ] I verified the stage execution order.
- [ ] I intentionally introduced an invalid analysis result.
- [ ] I observed the report worker reject the invalid result.
- [ ] I restored the correct implementation.
- [ ] I verified a new pipeline completed successfully.
- [ ] `npm run build` succeeds.
- [ ] `npm run test:run` succeeds.

## Success Criteria

Lecture 16 is complete when the three-stage pipeline executes in dependency order, each stage receives the correct previous-stage result, the root job returns the final report, the intentional failure is detected, and the corrected implementation passes verification.

Do not proceed until you have tested the implementation locally.

---

## Next Lecture

**Module 2 — Lecture 17: Batch Jobs & Bulk Enqueue**

We will learn how to submit large batches efficiently, manage bounded batch sizes, handle partial failures, control memory consumption, and distinguish bulk insertion from parallel job execution.

## Official References

- BullMQ Flows: https://docs.bullmq.io/guide/flows
- BullMQ Workers: https://docs.bullmq.io/guide/workers
- BullMQ Retry behavior: https://docs.bullmq.io/guide/retrying-failing-jobs
