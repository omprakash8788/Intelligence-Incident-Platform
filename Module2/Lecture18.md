# Module 2 — Lecture 18: Parent–Child Jobs & Advanced Batch Orchestration

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [The Problem: Independent Jobs Are Not Enough](#2-the-problem-independent-jobs-are-not-enough)
3. [How BullMQ Parent–Child Dependencies Work](#3-how-bullmq-parent-child-dependencies-work)
4. [Architecture](#4-architecture)
5. [Create the Queue Definitions](#5-create-the-queue-definitions)
6. [Build the Parent–Child Flow](#6-build-the-parent-child-flow)
7. [Implement the Workers](#7-implement-the-workers)
8. [Create the Orchestration Service](#8-create-the-orchestration-service)
9. [Create the API Routes](#9-create-the-api-routes)
10. [Register the Route](#10-register-the-route)
11. [Integrate Worker Lifecycle](#11-integrate-worker-lifecycle)
12. [Unit Tests](#12-unit-tests)
13. [Build and Run](#13-build-and-run)
14. [API Verification](#14-api-verification)
15. [Intentional Break → Understand → Fix](#15-intentional-break--understand--fix)
16. [Production Trade-offs](#16-production-trade-offs)
17. [Final Folder Structure](#17-final-folder-structure)
18. [Success Criteria](#18-success-criteria)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why parent–child job dependencies are useful.
- How BullMQ's `FlowProducer` coordinates dependent jobs.
- Why a parent job waits for its children.
- How child workers return results to a parent worker.
- How to aggregate child results deterministically.
- How to query the status of a parent job.
- How to integrate new workers into startup, failure cleanup, and graceful shutdown.
- How to test flow construction without Redis.

### Our use case

Suppose our Production Intelligence & Incident Platform receives a batch of service names:

```json
{
  "items": [
    "Redis",
    "PostgreSQL",
    "API Gateway"
  ]
}
```

Each service needs an independent processing task. After all child tasks finish, a parent job combines their results into a batch summary.

The workflow is:

1. Create a parent job.
2. Create one child job per input item.
3. Process children independently.
4. Wait for the children to finish.
5. Aggregate their results in the parent.
6. Make the final result available through an API.

This is a dependency-aware workflow, not merely a bulk enqueue operation.

### Important connection to previous lectures

You already implemented fan-out/fan-in in Lecture 15 and job pipelines in Lecture 16.

This lecture develops the underlying parent–child dependency model more explicitly. We will use a separate queue namespace so this example does not interfere with the existing fan-out and pipeline workflows.

---

## 2. The Problem: Independent Jobs Are Not Enough

In Lecture 17, we used:

```ts
await demoQueue.addBulk(jobs);
```

That is appropriate when the jobs are independent and do not need a parent to collect their results.

But imagine we want a final summary containing the result of every child.

Submitting independent jobs creates a coordination problem:

- How do we know when every child has finished?
- How do we associate each child with its parent?
- How do we prevent the parent from running too early?
- How do we collect all child results?
- What happens if one child fails?

We could implement our own database tables, counters, polling, and synchronization logic.

BullMQ already provides a dependency mechanism for this kind of workflow.

The relevant abstraction is `FlowProducer`.

---

## 3. How BullMQ Parent–Child Dependencies Work

BullMQ represents a workflow as a tree of jobs.

```text
                 Parent Job
                     |
          +----------+----------+
          |          |          |
       Child A     Child B     Child C
```

The children can be processed independently. The parent is blocked until its child dependencies have completed successfully.

For a simple flow, the sequence is:

1. The producer creates the parent and its children.
2. Child jobs become eligible for processing.
3. Workers process the children.
4. BullMQ tracks the dependencies.
5. When all required children complete, the parent becomes eligible.
6. The parent reads child results and produces the final output.

### What does the parent wait for?

The parent does not simply sleep for a fixed period. BullMQ tracks the dependency relationship.

The parent can remain in a waiting-for-children state until its dependencies are satisfied.

### What if a child fails?

A child can retry according to its configured retry policy.

Until the dependency is satisfied, the parent cannot perform its normal aggregation work.

If a child exhausts its retries, the parent will not automatically produce a successful summary containing all expected results. Failure handling must be designed deliberately.

### What does `getChildrenValues()` do?

Inside the parent worker, BullMQ provides:

```ts
const childResults = await job.getChildrenValues();
```

It returns the completed child results keyed by BullMQ job keys.

Do not assume the keys or object iteration order represent your original input order. We will store an explicit index in every child result and sort the results before aggregation.

---

## 4. Architecture

```text
POST /demo/parent-child
          |
          v
   Validate input
          |
          v
 Parent–Child Service
          |
          v
    FlowProducer
          |
          v
   Redis / BullMQ
          |
          +---------------------+
          |          |          |
          v          v          v
       Child A    Child B    Child C
          |          |          |
          +----------+----------+
                     |
                     v
              Parent becomes
                eligible
                     |
                     v
               Parent Worker
                     |
                     v
             Aggregated Result
                     |
                     v
      GET /demo/parent-child/:id
```

### Files we'll create

| Action | File |
|---|---|
| Create | `src/queues/parent-child.queue-names.ts` |
| Create | `src/queues/parent-child.queues.ts` |
| Create | `src/queues/jobs/parent-child.job.ts` |
| Create | `src/services/parent-child-flow-builder.ts` |
| Create | `src/services/parent-child.service.ts` |
| Create | `src/workers/parent-child-item.worker.ts` |
| Create | `src/workers/parent-child-parent.worker.ts` |
| Create | `src/routes/parent-child.routes.ts` |
| Create | `tests/parent-child-flow-builder.test.ts` |
| Modify | `src/app.ts` |
| Modify | `src/workers.ts` |

We will use your existing `createBullMQConnection()` factory. Do not create a separate Redis client for this lecture.

---

## 5. Create the Queue Definitions

### 5.1 Define the queue names

**File: `src/queues/parent-child.queue-names.ts`**

**Action: CREATE this file.**

```ts
export const PARENT_CHILD_ITEM_QUEUE =
  "parent-child-item";

export const PARENT_CHILD_PARENT_QUEUE =
  "parent-child-parent";
```

Why use constants?

Queue names are shared between producers, workers, and monitoring code. Centralizing them avoids subtle errors caused by spelling a queue name differently in different files.

### 5.2 Create the queues and FlowProducer

**File: `src/queues/parent-child.queues.ts`**

**Action: CREATE this file.**

```ts
import {
  FlowProducer,
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  PARENT_CHILD_ITEM_QUEUE,
  PARENT_CHILD_PARENT_QUEUE
} from "./parent-child.queue-names.js";

export const parentChildItemQueue =
  new Queue(PARENT_CHILD_ITEM_QUEUE, {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });

export const parentChildParentQueue =
  new Queue(PARENT_CHILD_PARENT_QUEUE, {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });

export const parentChildFlowProducer =
  new FlowProducer({
    connection: createBullMQConnection(1)
  });

export const waitForParentChildQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      parentChildItemQueue.waitUntilReady(),
      parentChildParentQueue.waitUntilReady()
    ]);
  };

export const closeParentChildQueues =
  async (): Promise<void> => {
    await Promise.allSettled([
      parentChildFlowProducer.close(),
      parentChildItemQueue.close(),
      parentChildParentQueue.close()
    ]);
  };
```

### Understand the connections

This module creates:

- One queue for child processing.
- One queue for parent aggregation.
- One `FlowProducer` for creating dependency-aware workflows.

Each resource owns its BullMQ connection lifecycle.

The existing connection factory uses `ioredis`-compatible connection options and should remain the single source for these connection settings.

### Why use `Promise.allSettled()` during cleanup?

A failure closing one resource should not prevent attempts to close the others.

This is especially useful during shutdown or startup failure cleanup.

It does not guarantee every close operation succeeded. Production systems should log cleanup failures when they need detailed diagnostics.

---

## 6. Build the Parent–Child Flow

### 6.1 Define the job types

**File: `src/queues/jobs/parent-child.job.ts`**

**Action: CREATE this file.**

```ts
export interface ParentChildItemData {
  batchId: string;
  index: number;
  value: string;
}

export interface ParentChildItemResult {
  batchId: string;
  index: number;
  originalValue: string;
  normalizedValue: string;
}

export interface ParentChildParentData {
  batchId: string;
  itemCount: number;
}

export interface ParentChildParentResult {
  batchId: string;
  completedCount: number;
  items: ParentChildItemResult[];
  summary: string;
}
```

These interfaces describe the contract between the producer and the workers.

The child result contains the original index so the parent can reconstruct the input order.

### 6.2 Create a pure flow builder

**File: `src/services/parent-child-flow-builder.ts`**

**Action: CREATE this file.**

```ts
import {
  PARENT_CHILD_ITEM_QUEUE,
  PARENT_CHILD_PARENT_QUEUE
} from "../queues/parent-child.queue-names.js";

import type {
  ParentChildItemData,
  ParentChildParentData
} from "../queues/jobs/parent-child.job.js";

export interface ParentChildFlowDefinition {
  name: string;
  queueName: string;
  data: ParentChildItemData | ParentChildParentData;
  opts?: {
    attempts?: number;
    backoff?: {
      type: "exponential";
      delay: number;
    };
  };
  children?: ParentChildFlowDefinition[];
}

export const buildParentChildFlow = (
  batchId: string,
  items: string[]
): ParentChildFlowDefinition => {
  return {
    name: "aggregate-batch",
    queueName: PARENT_CHILD_PARENT_QUEUE,
    data: {
      batchId,
      itemCount: items.length
    },
    opts: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      }
    },
    children: items.map((value, index) => ({
      name: "process-batch-item",
      queueName: PARENT_CHILD_ITEM_QUEUE,
      data: {
        batchId,
        index,
        value
      },
      opts: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000
        }
      }
    }))
  };
};
```

### Understand the flow definition

The root is the parent job:

```ts
{
  name: "aggregate-batch",
  queueName: PARENT_CHILD_PARENT_QUEUE,
  data: {
    batchId,
    itemCount: items.length
  }
}
```

Its `children` property defines the dependent child jobs.

For every input item, the builder creates a child containing:

- The batch identifier.
- The item's original index.
- The input value.

The builder does not connect to Redis or enqueue anything. It constructs a data structure.

This separation makes the builder easy to test.

### Why is the builder useful?

A pure builder is easier to reason about than code that simultaneously validates input, creates a workflow, connects to Redis, and sends an HTTP response.

It also lets us test the exact dependency structure without starting workers.

---

## 7. Implement the Workers

### 7.1 Create the child worker

**File: `src/workers/parent-child-item.worker.ts`**

**Action: CREATE this file.**

```ts
import {
  Job,
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PARENT_CHILD_ITEM_QUEUE
} from "../queues/parent-child.queue-names.js";

import type {
  ParentChildItemData,
  ParentChildItemResult
} from "../queues/jobs/parent-child.job.js";

import { logger } from "../logging/logger.js";

export const parentChildItemWorker =
  new Worker<
    ParentChildItemData,
    ParentChildItemResult
  >(
    PARENT_CHILD_ITEM_QUEUE,
    async (
      job: Job<ParentChildItemData>
    ): Promise<ParentChildItemResult> => {
      const normalizedValue =
        job.data.value.trim().toLowerCase();

      if (normalizedValue.length === 0) {
        throw new Error(
          "Child item cannot be empty"
        );
      }

      const result: ParentChildItemResult = {
        batchId: job.data.batchId,
        index: job.data.index,
        originalValue: job.data.value,
        normalizedValue
      };

      logger.info("Parent-child item completed", {
        batchId: result.batchId,
        index: result.index,
        normalizedValue: result.normalizedValue,
        jobId: job.id
      });

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 5
    }
  );
```

### What does the child worker do?

It normalizes an input string.

For example:

```text
"  PostgreSQL  "
```

becomes:

```text
"postgresql"
```

This is a deterministic demonstration task. We are not calling any external service or adding AI.

The worker returns a structured result. BullMQ stores the successful return value, making it available to the parent through its dependency API.

### Why set concurrency to 5?

It allows this worker to process multiple eligible jobs concurrently.

It does not guarantee five simultaneous jobs at all times. Actual execution depends on how many jobs are available, the worker's state, and Redis connectivity.

### 7.2 Create the parent worker

**File: `src/workers/parent-child-parent.worker.ts`**

**Action: CREATE this file.**

```ts
import {
  Job,
  Worker
} from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  PARENT_CHILD_PARENT_QUEUE
} from "../queues/parent-child.queue-names.js";

import type {
  ParentChildItemResult,
  ParentChildParentData,
  ParentChildParentResult
} from "../queues/jobs/parent-child.job.js";

import { logger } from "../logging/logger.js";

export const parentChildParentWorker =
  new Worker<
    ParentChildParentData,
    ParentChildParentResult
  >(
    PARENT_CHILD_PARENT_QUEUE,
    async (
      job: Job<ParentChildParentData>
    ): Promise<ParentChildParentResult> => {
      const childResults =
        await job.getChildrenValues<
          ParentChildItemResult
        >();

      const items = Object.values(childResults);

      if (items.length !== job.data.itemCount) {
        throw new Error(
          `Expected ${job.data.itemCount} child results, received ${items.length}`
        );
      }

      const orderedItems = [...items].sort(
        (a, b) => a.index - b.index
      );

      const invalidResult = orderedItems.some(
        (item, index) =>
          item.batchId !== job.data.batchId ||
          item.index !== index
      );

      if (invalidResult) {
        throw new Error(
          "Child results do not match the expected batch"
        );
      }

      const summary = orderedItems
        .map((item) => item.normalizedValue)
        .join(", ");

      const result: ParentChildParentResult = {
        batchId: job.data.batchId,
        completedCount: orderedItems.length,
        items: orderedItems,
        summary
      };

      logger.info("Parent-child batch aggregated", {
        batchId: result.batchId,
        completedCount: result.completedCount,
        jobId: job.id
      });

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 2
    }
  );
```

### Understand the parent worker

The parent worker does not need to poll every child job.

BullMQ coordinates the dependencies. The parent becomes eligible when the required children have completed successfully.

Inside the processor:

1. `getChildrenValues()` retrieves the child return values.
2. We verify the number of returned results.
3. We sort results by the original input index.
4. We verify that the results belong to the expected batch.
5. We build the final summary.
6. We return a structured parent result.

### Why validate the number of children?

The parent expects exactly `itemCount` child results.

If that invariant is violated, the worker throws instead of silently producing an incomplete summary.

This is a defensive check. It does not replace BullMQ's dependency tracking.

### Why validate the indexes?

Sorting is only useful if the indexes are valid.

The check verifies that the results contain the expected contiguous index sequence from zero through `itemCount - 1`.

---

## 8. Create the Orchestration Service

**File: `src/services/parent-child.service.ts`**

**Action: CREATE this file.**

```ts
import { randomUUID } from "node:crypto";

import {
  parentChildFlowProducer,
  parentChildParentQueue
} from "../queues/parent-child.queues.js";

import {
  buildParentChildFlow
} from "./parent-child-flow-builder.js";

const MAX_BATCH_SIZE = 20;
const MAX_ITEM_LENGTH = 200;

export interface SubmitParentChildBatchResult {
  batchId: string;
  parentJobId: string;
  itemCount: number;
}

export const submitParentChildBatch = async (
  items: string[]
): Promise<SubmitParentChildBatchResult> => {
  if (!Array.isArray(items)) {
    throw new TypeError(
      "Items must be an array"
    );
  }

  if (
    items.length === 0 ||
    items.length > MAX_BATCH_SIZE
  ) {
    throw new RangeError(
      `Batch size must be between 1 and ${MAX_BATCH_SIZE}`
    );
  }

  const validItems = items.every(
    (item) =>
      typeof item === "string" &&
      item.trim().length > 0 &&
      item.length <= MAX_ITEM_LENGTH
  );

  if (!validItems) {
    throw new TypeError(
      `Each item must be a non-empty string of at most ${MAX_ITEM_LENGTH} characters`
    );
  }

  const normalizedInputs = items.map(
    (item) => item.trim()
  );

  const batchId = randomUUID();

  const flow = buildParentChildFlow(
    batchId,
    normalizedInputs
  );

  const result = await parentChildFlowProducer.add(
    flow
  );

  if (!result.job.id) {
    throw new Error(
      "BullMQ did not return a parent job ID"
    );
  }

  return {
    batchId,
    parentJobId: result.job.id,
    itemCount: normalizedInputs.length
  };
};

export const getParentChildBatchStatus = async (
  parentJobId: string
) => {
  const job = await parentChildParentQueue.getJob(
    parentJobId
  );

  if (!job) {
    return null;
  }

  const state = await job.getState();

  return {
    parentJobId: job.id,
    batchId: job.data.batchId,
    itemCount: job.data.itemCount,
    state,
    result: job.returnvalue,
    failedReason: job.failedReason || null
  };
};
```

### Why create a batch ID?

The batch ID is a correlation identifier for the workflow.

It allows logs from different child jobs and the parent to be associated with the same logical batch.

It is separate from the BullMQ parent job ID. They serve different purposes.

### Why limit the batch to 20 items?

This is a deliberately conservative demonstration limit.

Each input creates a child job and a parent job. In a production service, choose limits based on payload size, expected processing cost, queue capacity, and request rate.

### Why return the parent job ID?

The client can use that ID to retrieve the workflow's current state.

The submission response does not mean the workflow is complete.

### Why return `null` for a missing job?

The API can distinguish a nonexistent job from a known job that is still waiting, processing, or completed.

One caveat: if completed jobs are removed from Redis, a previously valid job ID may no longer be queryable. Persistent batch tracking is a later architectural improvement.

---

## 9. Create the API Routes

**File: `src/routes/parent-child.routes.ts`**

**Action: CREATE this file.**

```ts
import { Router } from "express";

import {
  getParentChildBatchStatus,
  submitParentChildBatch
} from "../services/parent-child.service.js";

export const parentChildRoutes = Router();

const MAX_BATCH_SIZE = 20;
const MAX_ITEM_LENGTH = 200;

parentChildRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const items: unknown = req.body?.items;

      if (!Array.isArray(items)) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The items field must be an array"
          }
        });
        return;
      }

      if (
        items.length === 0 ||
        items.length > MAX_BATCH_SIZE
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `Submit between 1 and ${MAX_BATCH_SIZE} items`
          }
        });
        return;
      }

      const validItems = items.every(
        (item: unknown) =>
          typeof item === "string" &&
          item.trim().length > 0 &&
          item.length <= MAX_ITEM_LENGTH
      );

      if (!validItems) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `Each item must be a non-empty string of at most ${MAX_ITEM_LENGTH} characters`
          }
        });
        return;
      }

      const result = await submitParentChildBatch(
        items as string[]
      );

      res.status(202).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

parentChildRoutes.get(
  "/:parentJobId",
  async (req, res, next) => {
    try {
      const result =
        await getParentChildBatchStatus(
          req.params.parentJobId
        );

      if (!result) {
        res.status(404).json({
          success: false,
          error: {
            code: "PARENT_JOB_NOT_FOUND",
            message: "Parent job was not found"
          }
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);
```

### Endpoint 1: Submit a workflow

```text
POST /demo/parent-child
```

### Endpoint 2: Check workflow status

```text
GET /demo/parent-child/:parentJobId
```

The status endpoint reports the parent job's state and result.

The possible states depend on BullMQ's lifecycle and may include waiting, waiting for children, active, completed, and failed.

Do not treat every non-completed state as a failure.

---

## 10. Register the Route

**File: `src/app.ts`**

**Action: MODIFY this file. Do not replace the complete file.**

### Step 1: Add the import

```ts
import {
  parentChildRoutes
} from "./routes/parent-child.routes.js";
```

### Step 2: Register the route

Add the following alongside your other route registrations:

```ts
app.use(
  "/demo/parent-child",
  parentChildRoutes
);
```

Preserve your existing application structure.

The effective middleware order must still ensure that:

1. JSON request bodies are parsed.
2. Request IDs, logging, and security middleware remain in place.
3. Routes are registered before the not-found middleware.
4. The error middleware remains last.

Do not register duplicate middleware or replace unrelated route registrations.

---

## 11. Integrate Worker Lifecycle

Your existing `src/workers.ts` already manages the demo, external API, fan-out, and pipeline workers.

The new workers must participate in that same lifecycle.

### 11.1 Add imports

**File: `src/workers.ts`**

**Action: MODIFY this file by adding these imports alongside your existing worker and queue imports.**

```ts
import {
  parentChildItemWorker
} from "./workers/parent-child-item.worker.js";

import {
  parentChildParentWorker
} from "./workers/parent-child-parent.worker.js";

import {
  closeParentChildQueues,
  waitForParentChildQueuesReady
} from "./queues/parent-child.queues.js";
```

### 11.2 Add readiness checks

Inside your existing `start()` function, after the existing queue readiness checks, add:

```ts
await waitForParentChildQueuesReady();

await Promise.all([
  parentChildItemWorker.waitUntilReady(),
  parentChildParentWorker.waitUntilReady()
]);
```

Keep the existing readiness checks for demo, external API, fan-out, and pipeline workers.

Do not create a second `start()` function.

### 11.3 Add startup failure cleanup

In your existing startup `catch` block, include both new workers and the queue resources in the existing `Promise.allSettled()` cleanup.

**File: `src/workers.ts`**

**Action: MODIFY the existing cleanup array. Add these entries alongside the resources already being closed.**

```ts
parentChildItemWorker.close(),
parentChildParentWorker.close(),
closeParentChildQueues()
```

Your cleanup should continue to include the existing demo worker, external API worker, fan-out workers, pipeline workers, queue events, and their queue resources.

Do not remove the existing cleanup entries.

### 11.4 Add graceful shutdown

Inside the existing `shutdown()` function, add the new workers to the existing `Promise.all()` that closes workers.

**File: `src/workers.ts`**

**Action: MODIFY the existing worker-close array.**

```ts
parentChildItemWorker.close(),
parentChildParentWorker.close()
```

Then add the queue cleanup after the worker-close operation and alongside your existing resource cleanup.

**File: `src/workers.ts`**

**Action: MODIFY the existing shutdown sequence.**

```ts
await closeParentChildQueues();
```

The intended sequence is:

1. Stop and close workers.
2. Close queue events and other existing worker resources.
3. Close the new parent–child queues and `FlowProducer`.
4. Close the remaining existing queue resources.
5. Log successful shutdown and set the exit code.

Preserve your existing shutdown guard and error handling.

**Important:** If you are adding these calls to a list of resources closed by `Promise.allSettled()`, do not close the same resources twice in the same cleanup path without a reason. Keep startup-failure cleanup and normal shutdown logically separate.

---

## 12. Unit Tests

We'll test the flow builder without requiring Redis.

### 12.1 Create the flow-builder test

**File: `tests/parent-child-flow-builder.test.ts`**

**Action: CREATE this file.**

```ts
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
```

The empty-input test checks the builder's structural behavior only. The service is responsible for rejecting empty batches before calling the builder.

### 12.2 Run the targeted test

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/parent-child-flow-builder.test.ts
```

Expected: all four tests pass.

### 12.3 Run all tests

**Terminal: PowerShell**

```powershell
npm run test:run
```

Expected: the new tests pass without breaking your existing fan-out, pipeline, queue-routing, or other tests.

If the TypeScript compiler reports an incompatible `FlowProducer.add()` argument, resolve the flow definition's types against your installed BullMQ version. Do not work around it by casting the entire flow to `any`.

---

## 13. Build and Run

Run these commands from:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

### Step 1: Build

**Terminal: PowerShell**

```powershell
npm run build
```

Expected: no TypeScript errors.

### Step 2: Start the API

**Terminal 1: PowerShell**

```powershell
npm run dev
```

Wait until the API is ready.

### Step 3: Start the worker process

**Terminal 2: PowerShell**

```powershell
npm run dev:worker
```

Wait until both parent–child workers are ready.

You should see your existing worker startup log along with the new workers' readiness events, if those are logged by your current implementation.

Do not start a separate process just for the new workers. They are registered in the existing worker process.

---

## 14. API Verification

### 14.1 Submit a batch

**Terminal: PowerShell**

```powershell
$body = @{
    items = @(
        "Redis",
        "PostgreSQL",
        "API Gateway"
    )
} | ConvertTo-Json -Depth 5

$response = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/parent-child" `
    -ContentType "application/json" `
    -Body $body

$response
```

Expected response structure:

```json
{
  "success": true,
  "data": {
    "batchId": "generated-batch-id",
    "parentJobId": "generated-parent-job-id",
    "itemCount": 3
  }
}
```

The IDs are illustrative. Your application will generate actual identifiers.

Save the parent job ID from the response.

### 14.2 Check the status

**Terminal: PowerShell**

```powershell
$parentJobId = $response.data.parentJobId

Invoke-RestMethod `
    -Method Get `
    -Uri "http://localhost:3000/demo/parent-child/$parentJobId"
```

Immediately after submission, the parent may still be waiting for its children.

Run the status request again after the workers have had time to process the jobs.

A successful completed response should have a structure similar to:

```json
{
  "success": true,
  "data": {
    "parentJobId": "generated-parent-job-id",
    "batchId": "generated-batch-id",
    "itemCount": 3,
    "state": "completed",
    "result": {
      "batchId": "generated-batch-id",
      "completedCount": 3,
      "items": [
        {
          "batchId": "generated-batch-id",
          "index": 0,
          "originalValue": "Redis",
          "normalizedValue": "redis"
        },
        {
          "batchId": "generated-batch-id",
          "index": 1,
          "originalValue": "PostgreSQL",
          "normalizedValue": "postgresql"
        },
        {
          "batchId": "generated-batch-id",
          "index": 2,
          "originalValue": "API Gateway",
          "normalizedValue": "api gateway"
        }
      ],
      "summary": "redis, postgresql, api gateway"
    },
    "failedReason": null
  }
}
```

The generated IDs and exact timing will differ.

The important properties are:

- The parent completes only after the children complete successfully.
- `completedCount` equals the input count.
- The results preserve the original input order.
- The final summary contains the normalized values.

### 14.3 Test an invalid empty batch

**Terminal: PowerShell**

```powershell
$body = @{
    items = @()
} | ConvertTo-Json

try {
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://localhost:3000/demo/parent-child" `
        -ContentType "application/json" `
        -Body $body
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `400 Bad Request`.

### 14.4 Test a batch that is too large

**Terminal: PowerShell**

```powershell
$items = 1..21 | ForEach-Object {
    "Service $_"
}

$body = @{
    items = $items
} | ConvertTo-Json -Depth 5

try {
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://localhost:3000/demo/parent-child" `
        -ContentType "application/json" `
        -Body $body
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `400 Bad Request`.

### 14.5 Test a missing parent ID

**Terminal: PowerShell**

```powershell
try {
    Invoke-RestMethod `
        -Method Get `
        -Uri "http://localhost:3000/demo/parent-child/nonexistent-job-id"
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `404 Not Found`.

---

## 15. Intentional Break → Understand → Fix

### Break 1: Remove the index sorting

**File: `src/workers/parent-child-parent.worker.ts`**

Temporarily replace:

```ts
const orderedItems = [...items].sort(
  (a, b) => a.index - b.index
);
```

with:

```ts
const orderedItems = [...items];
```

Submit a batch with at least three items.

The output may still appear correct because the current workflow often returns results in a convenient order. However, the implementation no longer explicitly guarantees the intended business order.

Do not rely on the order of an object returned by `getChildrenValues()` as your business-ordering contract.

### Understand the failure

A dependency graph represents relationships between jobs, not necessarily the order in which your business data must appear.

Worker concurrency can change completion order. If the output order matters, persist an explicit sequence number and use it.

### Fix 1

Restore the sorting operation:

```ts
const orderedItems = [...items].sort(
  (a, b) => a.index - b.index
);
```

Run the API request again and verify that the output order matches the original input.

### Break 2: Return the wrong index

**File: `src/workers/parent-child-item.worker.ts`**

Temporarily change:

```ts
index: job.data.index,
```

to:

```ts
index: job.data.index + 1,
```

Submit a new batch.

The parent should reject the child results because the index sequence no longer matches the expected range starting at zero.

Depending on the configured retry policy, the parent may retry before reaching a terminal failed state.

### Understand the failure

The parent validates a workflow invariant: each expected child must return a result associated with the correct batch and index.

Without this check, incorrect or duplicated results could silently produce a misleading summary.

### Fix 2

Restore:

```ts
index: job.data.index,
```

Submit a new batch and verify that it completes successfully.

Do not assume an earlier failed job will automatically become successful after you edit the code. Use a new batch for the verification.

### Final verification

**Terminal: PowerShell**

```powershell
npm run build
npm run test:run
```

Then submit a new valid batch and verify its completed result through the status endpoint.

---

## 16. Production Trade-offs

### 16.1 A parent–child flow is not a distributed transaction

BullMQ tracks dependencies in Redis. It does not make your database, Redis, and external systems one atomic transaction.

If a child updates PostgreSQL and then crashes before completing its BullMQ job, a retry may repeat that database operation.

Production workers should therefore use idempotent operations where repeated execution is possible.

### 16.2 Failed children need an explicit policy

Our current parent is designed to produce a complete summary.

If a child exhausts its retries, the parent should not be assumed to complete successfully.

Possible business policies include:

- Fail the entire batch.
- Retry the failed child through a controlled recovery workflow.
- Record partial results and explicitly mark the batch as partially failed.
- Send the failed batch for manual review.

These policies are not interchangeable. Choose according to the business requirement.

### 16.3 Job retention affects status lookup

Our queue configuration removes older completed jobs after a retention limit.

That means a parent job may eventually disappear from Redis. At that point, the status endpoint can no longer retrieve its return value from the queue.

For long-lived workflow tracking, persist a batch record and terminal state in PostgreSQL.

### 16.4 Parent–child flows can consume many Redis resources

A flow with 20 children creates at least 21 jobs: 20 children and one parent.

A much larger workflow can create a substantial number of jobs, dependency records, and stored return values.

Use bounded batches and monitor queue depth, processing time, failures, and Redis resource usage.

### 16.5 Parent concurrency and child concurrency are separate

The child worker uses concurrency 5, while the parent worker uses concurrency 2.

Those values control different queues and different stages.

They do not mean the entire workflow has a global concurrency of 5 or 2.

### 16.6 Do not confuse parent–child flows with pipelines

In a fan-out workflow, many children may run independently before a parent aggregates their results.

In a pipeline, stages depend on previous stages. A later stage typically cannot run until its prerequisite has completed.

Both can be modeled using BullMQ flow dependencies, but their business structures differ.

### 16.7 Observability is part of production readiness

A production implementation should record at least:

- Batch ID.
- Parent job ID.
- Child job ID.
- Queue name.
- Retry count.
- Processing duration.
- Failure reason.
- Final batch state.

Your current logger and correlation conventions provide a foundation. A later lecture can extend this into durable batch tracking and monitoring.

---

## 17. Final Folder Structure

The following shows only the files relevant to this lecture and nearby existing features.

```text
production-intelligence-platform/
├── src/
│   ├── queues/
│   │   ├── jobs/
│   │   │   └── parent-child.job.ts
│   │   ├── parent-child.queue-names.ts
│   │   └── parent-child.queues.ts
│   ├── services/
│   │   ├── parent-child-flow-builder.ts
│   │   └── parent-child.service.ts
│   ├── workers/
│   │   ├── parent-child-item.worker.ts
│   │   └── parent-child-parent.worker.ts
│   ├── routes/
│   │   └── parent-child.routes.ts
│   ├── app.ts
│   └── workers.ts
└── tests/
    └── parent-child-flow-builder.test.ts
```

The existing fan-out, pipeline, demo, and external API queue files remain in place.

---

## 18. Success Criteria

Before moving forward, confirm every item:

- [ ] The new parent and child queue names are centralized.
- [ ] The queue module uses the existing BullMQ connection factory.
- [ ] The flow builder creates one child per input item.
- [ ] The child worker returns a typed result.
- [ ] The parent worker waits for dependencies and reads child results.
- [ ] The parent sorts results by the original index.
- [ ] The parent validates the child count and result indexes.
- [ ] The orchestration service validates batch input.
- [ ] The submission endpoint returns the batch ID and parent job ID.
- [ ] The status endpoint returns the parent state and result.
- [ ] Missing jobs return HTTP 404.
- [ ] Invalid batches return HTTP 400.
- [ ] Both workers participate in startup and readiness checks.
- [ ] Both workers participate in startup failure cleanup.
- [ ] Both workers and their queue resources participate in graceful shutdown.
- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes.
- [ ] The intentional-break exercises have been fixed and re-tested.

### What you learned

You have now built a dependency-aware batch workflow in which independent child jobs return results to a coordinating parent job.

The key idea is that **job dependencies are managed by BullMQ, while business invariants, result ordering, validation, and failure policy remain application responsibilities.**

**Next lecture — Module 2, Lecture 19: Queue Routing Strategies & Workload Isolation.** We'll examine how to route different kinds of jobs to the appropriate queues and workers while protecting latency-sensitive work from slower workloads.