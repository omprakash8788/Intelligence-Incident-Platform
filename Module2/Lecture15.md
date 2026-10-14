# Module 2 — Lecture 15: Fan-Out / Fan-In Patterns

## Table of Contents

1. Learning objectives
2. Understand fan-out and fan-in
3. Architecture
4. Create job contracts
5. Define queue names
6. Create the BullMQ queues and FlowProducer
7. Build the fan-out flow definition
8. Create the fan-out service
9. Create the child worker
10. Create the aggregation worker
11. Create the API routes
12. Register the routes
13. Register worker lifecycle management
14. Add unit tests
15. Build and start the application
16. Test fan-out and fan-in
17. Break the implementation intentionally
18. Fix and retest
19. Production considerations
20. Final folder structure
21. Completion checklist

---

# 1. Learning Objectives

By the end of this lecture, you will understand:

- What fan-out and fan-in mean in distributed systems.
- How to split one request into multiple independent background jobs.
- How to process child jobs concurrently.
- How to wait for all child jobs before running an aggregation job.
- How BullMQ's `FlowProducer` manages parent-child dependencies.
- How to collect results from completed child jobs.
- How to handle child failures and parent retries.
- How to test parallel processing without connecting to Redis.
- How to reproduce and fix an aggregation failure.

We will implement a small workload for your Production Intelligence & Incident Platform.

The example will transform several input strings independently and then aggregate the results. The transformation is intentionally simple; the architecture is the important part.

**We will not integrate AI, replace your existing queues, or change the existing Lecture 13 and Lecture 14 behavior.**

## What we will build

One API request:

`POST /demo/fanout`

Example input:

```json
{
  "items": [
    "database unavailable",
    "redis timeout",
    "worker stalled"
  ]
}
```

The application will:

1. Create a workflow ID.
2. Create one child job for each input item.
3. Process the child jobs independently.
4. Wait until all children complete successfully.
5. Run a parent aggregation job.
6. Collect and return the child results.
7. Allow you to inspect the parent job's status.

---

# 2. Understand Fan-Out and Fan-In

## 2.1 Fan-out

Fan-out means splitting one larger task into multiple smaller tasks.

For example, one incident-analysis request might require processing ten independent records.

Instead of processing them sequentially:

```text
Request
   |
   v
Process item 1
   |
   v
Process item 2
   |
   v
Process item 3
   |
   v
Complete
```

We distribute the work:

```text
                 Request
                    |
             Fan-out operation
                    |
          +---------+---------+
          |         |         |
          v         v         v
        Job 1     Job 2     Job 3
          |         |         |
          v         v         v
        Result 1  Result 2  Result 3
```

Each child job can be processed independently.

## 2.2 Fan-in

Fan-in means combining the results from multiple tasks into one final result.

```text
        Result 1
            |
        Result 2
            |
        Result 3
            |
            v
      Aggregation Job
            |
            v
       Final Result
```

Fan-out distributes work. Fan-in coordinates its results.

## 2.3 Real-world use cases

| Use case | Fan-out tasks | Fan-in result |
|---|---|---|
| Incident processing | Inspect independent events | Combined incident summary |
| Log processing | Process log partitions | Aggregated statistics |
| Report generation | Generate report sections | Combined report |
| Notifications | Prepare individual notifications | Delivery summary |
| Data imports | Validate individual records | Import result |
| Health analysis | Check independent services | Overall health result |

A fan-out/fan-in architecture is useful when child tasks are independent and their results can be combined after completion.

---

# 3. Architecture

We will use BullMQ's `FlowProducer`.

BullMQ supports parent-child job relationships. A parent job remains in the `waiting-children` state until its dependencies are completed successfully. Once the dependencies are satisfied, the parent becomes eligible for processing.

Official reference: https://docs.bullmq.io/guide/flows

Our architecture:

```text
                    Express API
                         |
                         v
                   Fan-Out Service
                         |
                         v
                    FlowProducer
                         |
                +--------+--------+
                |                 |
                v                 v
          Child Job 1        Child Job 2
                |                 |
                v                 v
          Child Worker      Child Worker
                |                 |
                +--------+--------+
                         |
                         v
                  All children done
                         |
                         v
                  Parent becomes ready
                         |
                         v
                 Aggregation Worker
                         |
                         v
                  Combined results
```

We will create two dedicated queues:

- `fanout-task` — processes child jobs.
- `fanout-aggregate` — processes the parent aggregation job.

This keeps the new lesson isolated from the existing `demo-job` and `external-api` queues.

## Important terminology

- **Workflow:** The complete fan-out/fan-in operation.
- **Parent job:** The job responsible for aggregation.
- **Child job:** One independently processed task.
- **FlowProducer:** Creates the parent and its child jobs with their dependencies.
- **Worker:** Processes jobs from a queue.

---

# 4. Create Job Contracts

### File: `src/queues/jobs/fanout.job.ts`

**Action:** Create this file.

```ts
export interface FanoutTaskData {
  workflowId: string;
  itemId: string;
  value: string;
}

export interface FanoutTaskResult {
  workflowId: string;
  itemId: string;
  input: string;
  transformed: string;
}

export interface FanoutAggregateData {
  workflowId: string;
  expectedChildren: number;
}

export interface FanoutAggregateResult {
  workflowId: string;
  childCount: number;
  results: FanoutTaskResult[];
  completedAt: string;
}
```

## Explanation

### `FanoutTaskData`

This is the input received by each child worker.

`workflowId` connects the child to the overall workflow.

`itemId` uniquely identifies the individual item.

`value` contains the input to process.

### `FanoutTaskResult`

This describes the result returned by a child worker.

### `FanoutAggregateData`

The parent receives the workflow ID and the expected number of child jobs.

For example:

```ts
{
  workflowId: "workflow-123",
  expectedChildren: 3
}
```

### `FanoutAggregateResult`

This is the final result returned by the parent worker.

It includes the number of child results, all collected results, and the completion timestamp.

---

# 5. Define Queue Names

### File: `src/queues/fanout.queue-names.ts`

**Action:** Create this file.

```ts
export const FANOUT_TASK_QUEUE_NAME =
  "fanout-task";

export const FANOUT_AGGREGATE_QUEUE_NAME =
  "fanout-aggregate";
```

We keep queue names in one place so the producer, queues, and workers cannot accidentally use different literal names.

For example, `"fanout-task"` and `"fanout-tasks"` would represent two different queues. A spelling mismatch could leave jobs waiting indefinitely because the intended worker would not consume them.

---

# 6. Create the BullMQ Queues and FlowProducer

### File: `src/queues/fanout.queues.ts`

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
  FANOUT_AGGREGATE_QUEUE_NAME,
  FANOUT_TASK_QUEUE_NAME
} from "./fanout.queue-names.js";

import type {
  FanoutAggregateData,
  FanoutAggregateResult,
  FanoutTaskData,
  FanoutTaskResult
} from "./jobs/fanout.job.js";

export const fanoutTaskQueue = new Queue<
  FanoutTaskData,
  FanoutTaskResult
>(
  FANOUT_TASK_QUEUE_NAME,
  {
    connection:
      createBullMQConnection(1),

    defaultJobOptions: {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 1000
      },

      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const fanoutAggregateQueue = new Queue<
  FanoutAggregateData,
  FanoutAggregateResult
>(
  FANOUT_AGGREGATE_QUEUE_NAME,
  {
    connection:
      createBullMQConnection(1),

    defaultJobOptions: {
      attempts: 3,

      backoff: {
        type: "exponential",
        delay: 1000
      },

      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const fanoutFlowProducer =
  new FlowProducer({
    connection:
      createBullMQConnection(1)
  });

export const waitForFanoutQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      fanoutTaskQueue.waitUntilReady(),
      fanoutAggregateQueue.waitUntilReady(),
      fanoutFlowProducer.waitUntilReady()
    ]);
  };

export const closeFanoutQueues =
  async (): Promise<void> => {
    await Promise.all([
      fanoutFlowProducer.close(),
      fanoutTaskQueue.close(),
      fanoutAggregateQueue.close()
    ]);
  };
```

## Why do we create two queues?

The child queue handles individual tasks.

The parent queue handles aggregation.

They can have different worker concurrency, retry policies, and operational settings.

## Why do we create a `FlowProducer`?

The `FlowProducer` creates the parent job and its child jobs as a coordinated flow.

We do not manually create a parent job and then separately enqueue children. Doing so would introduce a gap in which the parent could become eligible before all its dependencies were registered.

The flow mechanism coordinates creation of the parent-child relationship.

## Why use `createBullMQConnection(1)`?

Your project already uses a connection factory that returns plain connection options compatible with BullMQ.

We reuse that factory instead of introducing a second connection configuration or adding an explicit `RedisOptions` return type.

---

# 7. Build the Fan-Out Flow Definition

We will separate flow construction from Redis operations. This makes the flow definition easy to unit-test.

### File: `src/services/fanout-flow-builder.ts`

**Action:** Create this file.

```ts
import {
  FANOUT_AGGREGATE_QUEUE_NAME,
  FANOUT_TASK_QUEUE_NAME
} from "../queues/fanout.queue-names.js";

import type {
  FanoutTaskData
} from "../queues/jobs/fanout.job.js";

export interface FanoutInputItem {
  itemId: string;
  value: string;
}

export const buildFanoutFlowDefinition = (
  workflowId: string,
  items: FanoutInputItem[]
) => {
  return {
    name: "aggregate-results",

    queueName:
      FANOUT_AGGREGATE_QUEUE_NAME,

    data: {
      workflowId,
      expectedChildren: items.length
    },

    opts: {
      attempts: 3,

      backoff: {
        type: "exponential" as const,
        delay: 1000
      }
    },

    children: items.map((item) => {
      const data: FanoutTaskData = {
        workflowId,
        itemId: item.itemId,
        value: item.value
      };

      return {
        name: "process-item",

        queueName:
          FANOUT_TASK_QUEUE_NAME,

        data,

        opts: {
          attempts: 3,

          backoff: {
            type: "exponential" as const,
            delay: 1000
          }
        }
      };
    })
  };
};
```

## What does this builder guarantee?

For three input items, it creates:

- One parent job.
- Three child jobs.
- A parent payload declaring three expected children.
- A dependency relationship between the parent and its children.

It does not connect to Redis or submit the flow. It only constructs the definition.

This separation gives us a simple unit-test target.

---

# 8. Create the Fan-Out Service

### File: `src/services/fanout.service.ts`

**Action:** Create this file.

```ts
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
```

## Why generate a workflow ID?

The workflow ID connects all child results to the same logical operation.

A single workflow may create many child jobs. Each child has its own `itemId`, but all children share the same `workflowId`.

This is useful for structured logs, tracing, and diagnosing failed workflows.

## Why validate in the service as well as the controller?

The controller protects the HTTP boundary.

The service may later be called from another controller, a scheduled task, or another internal module. It should enforce its own basic input invariants.

The HTTP route will also validate inputs so users receive clear client errors rather than internal exceptions.

---

# 9. Create the Child Worker

### File: `src/workers/fanout-task.worker.ts`

**Action:** Create this file.

```ts
import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  FANOUT_TASK_QUEUE_NAME
} from "../queues/fanout.queue-names.js";

import type {
  FanoutTaskData,
  FanoutTaskResult
} from "../queues/jobs/fanout.job.js";

import {
  logger
} from "../logging/logger.js";

export const fanoutTaskWorker =
  new Worker<
    FanoutTaskData,
    FanoutTaskResult
  >(
    FANOUT_TASK_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Fan-out child job started",
        {
          queue: FANOUT_TASK_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          itemId:
            job.data.itemId
        }
      );

      // Simulate a short asynchronous task.
      await new Promise<void>(
        (resolve) => {
          setTimeout(resolve, 100);
        }
      );

      const result: FanoutTaskResult = {
        workflowId:
          job.data.workflowId,

        itemId:
          job.data.itemId,

        input:
          job.data.value,

        transformed:
          job.data.value.toUpperCase()
      };

      logger.info(
        "Fan-out child job completed",
        {
          queue: FANOUT_TASK_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          itemId:
            job.data.itemId
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

fanoutTaskWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Fan-out child job failed",
      {
        queue: FANOUT_TASK_QUEUE_NAME,
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

fanoutTaskWorker.on(
  "error",
  (error) => {
    logger.error(
      "Fan-out child worker error",
      {
        queue: FANOUT_TASK_QUEUE_NAME,
        error: error.message
      }
    );
  }
);
```

## Why is child-worker concurrency set to five?

The worker can process multiple asynchronous child jobs concurrently.

Our demonstration task waits asynchronously for 100 milliseconds, so other jobs can make progress while a job is waiting.

The concurrency setting is local to this worker instance. If you run multiple instances, their combined processing capacity can increase.

For CPU-intensive jobs, high concurrency may not improve throughput. Concurrency is especially useful for workloads that spend time waiting on I/O.

Official reference: https://docs.bullmq.io/guide/parallelism-and-concurrency

---

# 10. Create the Aggregation Worker

### File: `src/workers/fanout-aggregate.worker.ts`

**Action:** Create this file.

```ts
import {
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  FANOUT_AGGREGATE_QUEUE_NAME
} from "../queues/fanout.queue-names.js";

import type {
  FanoutAggregateData,
  FanoutAggregateResult,
  FanoutTaskResult
} from "../queues/jobs/fanout.job.js";

import {
  logger
} from "../logging/logger.js";

const isFanoutTaskResult = (
  value: unknown
): value is FanoutTaskResult => {
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
    typeof result.itemId === "string" &&
    typeof result.input === "string" &&
    typeof result.transformed === "string"
  );
};

export const fanoutAggregateWorker =
  new Worker<
    FanoutAggregateData,
    FanoutAggregateResult
  >(
    FANOUT_AGGREGATE_QUEUE_NAME,

    async (job) => {
      logger.info(
        "Fan-in aggregation started",
        {
          queue:
            FANOUT_AGGREGATE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          expectedChildren:
            job.data.expectedChildren
        }
      );

      const childrenValues =
        await job.getChildrenValues();

      const rawResults: unknown[] =
        Object.values(childrenValues);

      const results =
        rawResults.filter(
          isFanoutTaskResult
        );

      if (
        results.length !==
        job.data.expectedChildren
      ) {
        throw new Error(
          `Expected ${job.data.expectedChildren} child results but received ${results.length}`
        );
      }

      const hasWrongWorkflow =
        results.some(
          (result) =>
            result.workflowId !==
            job.data.workflowId
        );

      if (hasWrongWorkflow) {
        throw new Error(
          "A child result belongs to a different workflow"
        );
      }

      const orderedResults =
        [...results].sort(
          (a, b) =>
            a.itemId.localeCompare(
              b.itemId
            )
        );

      const aggregateResult:
        FanoutAggregateResult = {
          workflowId:
            job.data.workflowId,

          childCount:
            orderedResults.length,

          results:
            orderedResults,

          completedAt:
            new Date().toISOString()
        };

      logger.info(
        "Fan-in aggregation completed",
        {
          queue:
            FANOUT_AGGREGATE_QUEUE_NAME,
          jobId: job.id,
          workflowId:
            job.data.workflowId,
          childCount:
            aggregateResult.childCount
        }
      );

      return aggregateResult;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 2
    }
  );

fanoutAggregateWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "Fan-in aggregation failed",
      {
        queue:
          FANOUT_AGGREGATE_QUEUE_NAME,
        jobId: job?.id,
        workflowId:
          job?.data.workflowId,
        error: error.message
      }
    );
  }
);

fanoutAggregateWorker.on(
  "error",
  (error) => {
    logger.error(
      "Fan-in aggregation worker error",
      {
        queue:
          FANOUT_AGGREGATE_QUEUE_NAME,
        error: error.message
      }
    );
  }
);
```

## How aggregation works

The parent calls:

```ts
await job.getChildrenValues();
```

BullMQ returns the values produced by its completed child jobs.

The aggregation worker then:

1. Collects all child values.
2. Validates the result shape.
3. Checks that the number of results matches the expected count.
4. Verifies that every result belongs to the same workflow.
5. Sorts results deterministically by `itemId`.
6. Returns the final aggregation result.

## Why sort the results?

Child jobs can finish in a different order from the order in which they were submitted.

If output order matters, do not assume completion order equals submission order.

Here we sort by the generated item ID so the output order is deterministic for a given workflow's item IDs. If business order matters, add an explicit `sequence` field to each child and sort by that field instead.

## Why validate child results?

Even when TypeScript types are defined, the data retrieved from Redis is runtime data.

A malformed or unexpected result should not silently become part of the final aggregation.

The expected child count is an additional consistency check. It does not replace the dependency mechanism; it helps detect incorrect aggregation data.

---

# 11. Create the API Routes

We will create:

- `POST /demo/fanout` — submit a workflow.
- `GET /demo/fanout/:parentJobId` — inspect workflow status and the final result.

### File: `src/routes/fanout.routes.ts`

**Action:** Create this file.

```ts
import {
  Router
} from "express";

import {
  fanoutAggregateQueue
} from "../queues/fanout.queues.js";

import {
  createFanoutWorkflow
} from "../services/fanout.service.js";

const router = Router();

router.post(
  "/demo/fanout",
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

      const items =
        requestBody.items;

      if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 10
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_ITEMS",
            message:
              "items must be an array containing between 1 and 10 strings"
          }
        });

        return;
      }

      const validItems =
        items.every(
          (item) =>
            typeof item === "string" &&
            item.trim().length > 0 &&
            item.length <= 500
        );

      if (!validItems) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_ITEM_VALUE",
            message:
              "Every item must be a non-empty string of at most 500 characters"
          }
        });

        return;
      }

      const workflow =
        await createFanoutWorkflow(
          items as string[]
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
  "/demo/fanout/:parentJobId",
  async (req, res, next) => {
    try {
      const parentJobId =
        req.params.parentJobId;

      const job =
        await fanoutAggregateQueue.getJob(
          parentJobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "FANOUT_WORKFLOW_NOT_FOUND",
            message:
              "The fan-out parent job was not found"
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
          expectedChildren:
            job.data.expectedChildren,
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

The server has accepted the workflow for background processing. The children may still be waiting or active.

The response does not claim that the aggregation has finished.

The client can use the returned `parentJobId` to inspect the workflow later.

## Why return the parent job state?

The parent job provides a convenient status for the overall workflow.

For example:

- `waiting-children` means child dependencies are still outstanding.
- `waiting` means the parent is ready to be processed.
- `active` means the aggregation worker is processing it.
- `completed` means the parent processor returned successfully.
- `failed` means the parent job exhausted its retry policy or otherwise entered a terminal failure state.

The status endpoint is a snapshot; the state may change immediately after the response.

---

# 12. Register the Routes

### File: `src/app.ts`

**Action:** Add this import with your other route imports.

```ts
import fanoutRoutes
  from "./routes/fanout.routes.js";
```

**Action:** Register the router with the other application routes.

```ts
app.use(fanoutRoutes);
```

Register it before your not-found middleware and error middleware.

Preserve all existing security middleware, request ID middleware, request logging, health routes, incident routes, demo routes, and monitoring routes.

**Do not replace the entire `app.ts` file.** Add only the import and registration described above.

---

# 13. Register Worker Lifecycle Management

The two new workers must start with your existing worker process and close during graceful shutdown.

### File: `src/workers.ts`

**Action 1:** Add these imports alongside your existing worker imports.

```ts
import {
  fanoutTaskWorker
} from "./workers/fanout-task.worker.js";

import {
  fanoutAggregateWorker
} from "./workers/fanout-aggregate.worker.js";

import {
  closeFanoutQueues,
  waitForFanoutQueuesReady
} from "./queues/fanout.queues.js";
```

**Action 2:** In your existing startup function, wait for the new queue resources and workers to become ready.

Add these calls alongside your existing readiness checks:

```ts
await waitForFanoutQueuesReady();

await Promise.all([
  fanoutTaskWorker.waitUntilReady(),
  fanoutAggregateWorker.waitUntilReady()
]);
```

Keep your existing demo worker, external API worker, and QueueEvents initialization.

**Action 3:** In your existing graceful shutdown sequence, close the new workers before closing their queue resources.

Add:

```ts
await Promise.all([
  fanoutTaskWorker.close(),
  fanoutAggregateWorker.close()
]);

await closeFanoutQueues();
```

Place these calls before the final shutdown-completed log.

Preserve the existing shutdown guard, signal handlers, other worker shutdown calls, and error handling. Do not register duplicate signal handlers.

## Why is shutdown order important?

Workers may still be processing jobs or interacting with Redis.

Closing workers first allows them to stop fetching work and finish active jobs according to BullMQ's shutdown behavior. Closing queue resources afterward prevents the application from leaving their Redis connections open.

If your current `workers.ts` closes shared resources in a different order, integrate these calls into that existing sequence rather than replacing the whole file.

---

# 14. Add Unit Tests

We will test the pure flow builder without Redis.

### File: `tests/fanout-flow-builder.test.ts`

**Action:** Create this file.

```ts
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
```

## What these tests prove

They verify that the flow definition contains:

- The correct parent queue.
- The correct number of child jobs.
- The expected child queue name.
- The correct workflow ID and item data.
- Retry configuration for both parent and children.

These tests do not prove that Redis creates the flow correctly or that workers process it. We will verify those behaviors with runtime tests.

---

# 15. Build and Start the Application

Open PowerShell.

## Step 1: Navigate to your project

```powershell
cd D:\Production-Intelligence-Incident-Platform\production-intelligence-platform
```

## Step 2: Build the TypeScript project

```powershell
npm run build
```

Expected result: compilation succeeds.

If you get an error involving `FlowProducer`, `Worker`, or connection options, stop and inspect the exact error before changing types. Reuse the connection factory already working in your project.

## Step 3: Run the unit tests

```powershell
npm run test:run
```

Expected result: all three new flow-builder tests pass, along with your existing tests.

If the project uses a different Vitest test-discovery pattern, place the test file according to your existing configuration rather than changing unrelated test settings.

## Step 4: Start PostgreSQL and Redis

```powershell
docker compose up -d postgres redis
```

Verify the containers:

```powershell
docker compose ps
```

PostgreSQL is not directly used by this lesson's fan-out flow, but it remains a dependency of your wider application.

## Step 5: Start the API

Open terminal 1:

```powershell
npm run dev
```

## Step 6: Start the worker process

Open terminal 2:

```powershell
npm run dev:worker
```

Check that both fan-out workers become ready:

- `fanout-task`
- `fanout-aggregate`

Also confirm that your existing workers and QueueEvents still initialize successfully.

---

# 16. Test Fan-Out and Fan-In

## Test A: Submit a workflow

Run in PowerShell:

```powershell
$body = @{
  items = @(
    "database unavailable",
    "redis timeout",
    "worker stalled"
  )
} | ConvertTo-Json -Depth 5

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/fanout" `
  -ContentType "application/json" `
  -Body $body

$response | ConvertTo-Json -Depth 10
```

Expected result:

- HTTP 202.
- `success` is `true`.
- A workflow ID is returned.
- A parent job ID is returned.
- `childCount` is 3.

The API response confirms that the flow was submitted, not that it has completed.

## Test B: Inspect the workflow

Use the returned parent job ID:

```powershell
$parentJobId = $response.data.parentJobId

Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/demo/fanout/$parentJobId" |
  ConvertTo-Json -Depth 10
```

You may initially see:

```json
{
  "success": true,
  "data": {
    "parentJobId": "...",
    "workflowId": "...",
    "expectedChildren": 3,
    "state": "waiting-children"
  }
}
```

The state may already have advanced by the time you inspect it. That is normal.

## Test C: Poll until completion

Use this PowerShell loop:

```powershell
$parentJobId = $response.data.parentJobId

do {
  $status = Invoke-RestMethod `
    -Method Get `
    -Uri "http://localhost:3000/demo/fanout/$parentJobId"

  Write-Host "Workflow state:" $status.data.state

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

Expected final state: `completed`.

The result should contain three child results, one for each input item.

The transformed values should be uppercase:

- `DATABASE UNAVAILABLE`
- `REDIS TIMEOUT`
- `WORKER STALLED`

The results may be ordered differently from the input because the child jobs can complete in any order. This implementation sorts by `itemId` before returning the result.

## Test D: Verify the worker logs

Observe the logs in the worker terminal.

You should see:

1. Multiple child jobs starting.
2. Child jobs completing.
3. The aggregation job starting only after all child dependencies are completed.
4. The aggregation job completing.

The exact log order depends on scheduling and Redis activity.

## Test E: Reject an empty list

```powershell
$body = @{
  items = @()
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/fanout" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_ITEMS`.

## Test F: Reject a non-string item

```powershell
$body = @{
  items = @(
    "database unavailable",
    123
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/fanout" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_ITEM_VALUE`.

PowerShell may display an exception for these non-2xx responses. That is expected.

---

# 17. Break the Implementation Intentionally

We now introduce a bug in the parent aggregation worker.

The purpose is to understand why result validation matters.

## Break A: Use an incorrect expected child count

### File: `src/workers/fanout-aggregate.worker.ts`

**Action:** Temporarily replace this condition:

```ts
if (
  results.length !==
  job.data.expectedChildren
) {
  throw new Error(
    `Expected ${job.data.expectedChildren} child results but received ${results.length}`
  );
}
```

with the following intentionally incorrect condition:

```ts
if (
  results.length !==
  job.data.expectedChildren + 1
) {
  throw new Error(
    `Expected ${job.data.expectedChildren + 1} child results but received ${results.length}`
  );
}
```

This introduces an off-by-one error.

If the workflow has three children, the parent incorrectly expects four results.

## Test the broken implementation

Run:

```powershell
npm run build
```

Restart the worker process so it loads the intentionally broken code.

Submit a new workflow with three items using Test A.

Poll the parent job's status using Test C.

Expected behavior:

- All three child jobs can complete.
- The parent becomes eligible for processing.
- The parent throws an aggregation error because it expects four results.
- BullMQ retries the parent according to the configured retry policy.
- After its attempts are exhausted, the parent enters the `failed` state.

The retry delay means you may need to wait several seconds before observing the terminal failure.

## Root-cause analysis

The child jobs completed correctly. The failure occurred in the aggregation step.

The problem is not that BullMQ lost the children. The application supplied the wrong expected count.

This demonstrates why fan-in logic must validate its inputs carefully.

A parent job should not silently report success if the number of results differs from the expected number of child tasks.

---

# 18. Fix and Retest

### File: `src/workers/fanout-aggregate.worker.ts`

**Action:** Restore the correct expected-count condition.

```ts
if (
  results.length !==
  job.data.expectedChildren
) {
  throw new Error(
    `Expected ${job.data.expectedChildren} child results but received ${results.length}`
  );
}
```

Rebuild:

```powershell
npm run build
```

Restart the worker process.

Submit a **new workflow** with three items and poll its parent status until it becomes `completed`.

Do not expect the previously failed workflow to repair itself automatically just because the source code changed. Its retries may already be exhausted. Submit a new workflow for the verification test.

## Final verification

- [ ] The new workflow returns HTTP 202.
- [ ] Three child jobs are created.
- [ ] All three children complete.
- [ ] The parent waits for its dependencies.
- [ ] The parent aggregates three results.
- [ ] The parent reaches `completed`.
- [ ] The intentionally broken parent fails.
- [ ] The corrected parent succeeds on a new workflow.
- [ ] `npm run build` succeeds.
- [ ] `npm run test:run` succeeds.

---

# 19. Production Considerations

## 19.1 Fan-out increases total work

If one request creates 1,000 child jobs, the system must handle 1,000 jobs, not one.

In this lesson, the API limits the number of items to ten to keep the demonstration bounded.

A production implementation needs appropriate limits on batch size, memory, queue growth, and the number of workflows submitted by each client.

## 19.2 Child concurrency is not the same as fan-out size

The workflow may create ten child jobs, while the worker concurrency is five.

That means the jobs may be processed in multiple waves. The concurrency setting limits simultaneous processing within that worker instance; it does not limit the total number of children created.

## 19.3 Parent dependencies are not exactly-once execution

BullMQ can retry jobs after failures. A child may execute more than once if a worker crashes or the job is retried.

Therefore, child processors should be idempotent when they perform externally visible operations.

For example, if a child sends a payment request, a retry must not create an unintended duplicate payment.

## 19.4 What if a child fails permanently?

With the default dependency behavior, a parent does not proceed as if every child succeeded when a child has exhausted its retries.

The workflow may remain blocked on the failed dependency until you explicitly handle the failure.

A production design must choose a policy:

- Retry transient failures.
- Fail the workflow if a required child fails.
- Continue with partial results when business rules permit it.
- Record failed child details and support controlled recovery.

BullMQ supports advanced dependency-failure behavior, but those options should be chosen based on business semantics, not added blindly.

## 19.5 Result retention matters

BullMQ's completed-job retention policy determines how long job records and results remain available.

If completed child jobs or the parent are removed, you must not assume their results will remain available indefinitely.

For long-lived workflows, consider persisting the business-level workflow state and final result in PostgreSQL.

## 19.6 Redis and PostgreSQL serve different roles

BullMQ and Redis coordinate job processing and dependencies.

PostgreSQL should hold durable business records when the workflow needs long-term auditability or transactional consistency.

A workflow in Redis is not automatically a durable business record in PostgreSQL.

## 19.7 Fan-out/fan-in does not solve the dual-write problem

Suppose you create an incident in PostgreSQL and then create a BullMQ flow in Redis.

If PostgreSQL commits but Redis is unavailable, the incident may exist without its background workflow.

A production solution may use a transactional outbox and a reliable dispatcher. We will study this pattern in Module 3.

## 19.8 Observability

For each workflow, record:

- Workflow ID.
- Parent job ID.
- Child job IDs.
- Number of children submitted.
- Number of children completed.
- Number of failed children.
- Total workflow duration.
- Aggregation duration.
- Retry counts.
- Final workflow status.

This allows you to distinguish a slow child, a failed dependency, and a slow aggregation worker.

## 19.9 Keep workload-specific queues separate

The child queue and parent queue can have different worker concurrency and operational policies.

If the aggregation operation later becomes CPU-intensive, it may need different resource allocation from the I/O-heavy child tasks.

---

# 20. Final Folder Structure

The new files introduced in this lecture are:

```text
src/
├── queues/
│   ├── fanout.queue-names.ts
│   ├── fanout.queues.ts
│   └── jobs/
│       └── fanout.job.ts
├── services/
│   ├── fanout-flow-builder.ts
│   └── fanout.service.ts
├── workers/
│   ├── fanout-task.worker.ts
│   └── fanout-aggregate.worker.ts
├── routes/
│   └── fanout.routes.ts
├── app.ts
└── workers.ts

tests/
└── fanout-flow-builder.test.ts
```

This is the relevant part of your project, not a replacement for the existing directory structure.

Your existing demo queue, external API queue, monitoring routes, Redis lifecycle, PostgreSQL configuration, and middleware should remain intact.

---

# 21. Completion Checklist

Before moving to Lecture 16, confirm the following:

- [ ] I understand fan-out and fan-in.
- [ ] I created the job contracts.
- [ ] I created the dedicated child and parent queues.
- [ ] I created the `FlowProducer`.
- [ ] I created the pure flow builder.
- [ ] I created the fan-out service.
- [ ] I created the child worker.
- [ ] I created the aggregation worker.
- [ ] I created and registered the API routes.
- [ ] I integrated the workers into the existing lifecycle.
- [ ] I added and passed the flow-builder unit tests.
- [ ] I submitted a workflow with three child jobs.
- [ ] I observed the child jobs complete.
- [ ] I observed the parent wait for dependencies.
- [ ] I observed the parent aggregate the results.
- [ ] I intentionally broke the expected child count.
- [ ] I observed the parent retry and eventually fail.
- [ ] I restored the correct count check.
- [ ] I verified that a new workflow completes successfully.
- [ ] `npm run build` succeeds.
- [ ] `npm run test:run` succeeds.

## Success Criteria

Lecture 15 is complete only when you can submit one workflow, observe its child jobs, confirm that the parent waits for the children, retrieve the aggregated result, reproduce the aggregation failure, and verify the corrected implementation.

Do not proceed until you have verified the workflow in your local project.

## Next Lecture

**Module 2 — Lecture 16: Job Pipelines & Dependencies**

We will build on these concepts to understand multi-stage processing, execution ordering, job dependencies, recovery behavior, and when to use a pipeline rather than independent fan-out tasks.

## Official References

- BullMQ Flows: https://docs.bullmq.io/guide/flows
- BullMQ Parallelism and Concurrency: https://docs.bullmq.io/guide/parallelism-and-concurrency
- BullMQ Worker Concurrency: https://docs.bullmq.io/guide/workers/concurrency
