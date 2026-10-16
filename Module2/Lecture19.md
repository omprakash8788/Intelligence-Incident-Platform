# Module 2 — Lecture 19: Queue Routing Strategies & Workload Isolation

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [The Problem: Workload Contention](#2-the-problem-workload-contention)
3. [Queue Routing vs. Workload Isolation](#3-queue-routing-vs-workload-isolation)
4. [Architecture](#4-architecture)
5. [Define the Workload Types](#5-define-the-workload-types)
6. [Create Dedicated Queues](#6-create-dedicated-queues)
7. [Implement the Routing Policy](#7-implement-the-routing-policy)
8. [Implement the Routing Service](#8-implement-the-routing-service)
9. [Implement the Workers](#9-implement-the-workers)
10. [Create the API Routes](#10-create-the-api-routes)
11. [Register the Route](#11-register-the-route)
12. [Integrate Worker Lifecycle](#12-integrate-worker-lifecycle)
13. [Unit Tests](#13-unit-tests)
14. [Build and Run](#14-build-and-run)
15. [API Verification](#15-api-verification)
16. [Intentional Break → Understand → Fix](#16-intentional-break--understand--fix)
17. [Production Trade-offs](#17-production-trade-offs)
18. [Final Folder Structure](#18-final-folder-structure)
19. [Success Criteria](#19-success-criteria)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why one queue is not always appropriate for every workload.
- The difference between queue routing and workload isolation.
- How to route jobs using explicit business rules.
- How dedicated queues and workers isolate processing capacity.
- Why interactive jobs may need different concurrency from batch jobs.
- How to test routing decisions independently of Redis.
- How to integrate additional queues and workers into your existing lifecycle.
- Why separate queues do not automatically guarantee latency or resource isolation.

### Our scenario

Imagine the Production Intelligence & Incident Platform receives two kinds of work.

**Interactive workload**

A user requests a quick operation, such as normalizing a service name or processing a small operational request.

The user expects a fast response.

**Batch workload**

A scheduled process submits many records for processing. Each task is independent, but the workload may be large and computationally expensive.

The batch workload can tolerate slower processing.

If both workloads use the same queue and worker pool, a large batch can occupy the available workers and delay interactive requests.

Our goal is to separate these workloads.

For this lecture, we will create two dedicated queues and two worker pools without modifying your existing demo, external API, fan-out, pipeline, or parent–child workflows.

---

## 2. The Problem: Workload Contention

Suppose one queue contains these jobs:

```text
Shared Queue
    |
    +-- Batch job 1       (slow)
    +-- Batch job 2       (slow)
    +-- Batch job 3       (slow)
    +-- Interactive job   (quick)
    +-- Batch job 4       (slow)
```

If all available workers are occupied by slow batch jobs, the interactive job may wait even though its own processing is inexpensive.

This is a form of workload contention.

### Why priorities alone are not always enough

BullMQ supports job priorities, but priorities are not the same as resource isolation.

For example:

- A high-priority job may still wait for a currently active worker to become available.
- Long-running jobs can occupy worker concurrency slots.
- A shared worker pool can still experience CPU or memory contention.
- External service calls can block useful capacity while waiting for responses.

Priority can influence which eligible job is processed next. It cannot automatically interrupt an active job and transfer its resources to another queue.

### Our solution

Create separate queues:

```text
Interactive Queue
    |
    +-- Interactive Worker Pool

Batch Queue
    |
    +-- Batch Worker Pool
```

The interactive worker pool can process more jobs concurrently, while the batch worker pool has its own concurrency limit.

This provides isolation at the queue and worker-pool level.

---

## 3. Queue Routing vs. Workload Isolation

These concepts are related but different.

| Concept | Responsibility |
|---|---|
| Routing policy | Decides which queue receives a job |
| Queue | Stores jobs waiting for processing |
| Worker pool | Processes jobs from a particular queue |
| Concurrency | Limits jobs processed concurrently by a worker |
| Rate limiting | Restricts processing throughput |
| Resource isolation | Separates CPU, memory, network, or process capacity |

For this lecture:

1. The API receives a workload classification.
2. A pure routing policy validates the classification.
3. A service chooses the corresponding queue.
4. A dedicated worker pool processes that queue.

We will use explicit routing rather than guessing a workload from its message text.

A routing rule should be predictable and testable.

---

## 4. Architecture

```text
                  HTTP Client
                      |
                      v
              POST /demo/workloads
                      |
                      v
                Validate Input
                      |
                      v
               Routing Policy
                      |
             +--------+--------+
             |                 |
             v                 v
      Interactive          Batch
         Queue              Queue
             |                 |
             v                 v
      Interactive          Batch
         Worker             Worker
       Concurrency 10     Concurrency 2
             |                 |
             +--------+--------+
                      |
                      v
               Process Result
```

The concurrency values are teaching defaults. They must be measured and tuned for the actual workload.

### Files to create

| Action | File |
|---|---|
| Create | `src/queues/workload.queue-names.ts` |
| Create | `src/queues/workload.queues.ts` |
| Create | `src/queues/jobs/workload.job.ts` |
| Create | `src/services/workload-routing.policy.ts` |
| Create | `src/services/workload-routing.service.ts` |
| Create | `src/workers/interactive-workload.worker.ts` |
| Create | `src/workers/batch-workload.worker.ts` |
| Create | `src/routes/workload.routes.ts` |
| Create | `tests/workload-routing.policy.test.ts` |
| Modify | `src/app.ts` |
| Modify | `src/workers.ts` |

We will reuse your existing BullMQ connection factory:

`src/queues/bullmq.connection.ts`

We will not create another Redis client.

---

## 5. Define the Workload Types

### 5.1 Create the job contract

**File: `src/queues/jobs/workload.job.ts`**

**Action: CREATE this file.**

```ts
export type WorkloadType =
  | "interactive"
  | "batch";

export interface WorkloadJobData {
  workloadId: string;
  workloadType: WorkloadType;
  message: string;
  submittedAt: string;
}

export interface WorkloadJobResult {
  workloadId: string;
  workloadType: WorkloadType;
  originalMessage: string;
  processedMessage: string;
  processedAt: string;
}
```

### Understand the contract

`workloadType` tells us which class of work was submitted.

`workloadId` identifies the individual job independently of the BullMQ job ID.

`submittedAt` allows us to measure elapsed processing time later.

The result includes both the original and processed message so that we can verify the transformation.

We use a discriminated union for the workload type:

```ts
type WorkloadType =
  | "interactive"
  | "batch";
```

This prevents arbitrary workload names from becoming valid routing targets.

---

## 6. Create Dedicated Queues

### 6.1 Define the queue names

**File: `src/queues/workload.queue-names.ts`**

**Action: CREATE this file.**

```ts
export const INTERACTIVE_WORKLOAD_QUEUE =
  "workload-interactive";

export const BATCH_WORKLOAD_QUEUE =
  "workload-batch";
```

Queue names should be centralized because the producer and worker must use exactly the same name.

### 6.2 Create both queues

**File: `src/queues/workload.queues.ts`**

**Action: CREATE this file.**

```ts
import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  INTERACTIVE_WORKLOAD_QUEUE,
  BATCH_WORKLOAD_QUEUE
} from "./workload.queue-names.js";

import type {
  WorkloadJobData,
  WorkloadJobResult
} from "./jobs/workload.job.js";

export const interactiveWorkloadQueue = new Queue<
  WorkloadJobData,
  WorkloadJobResult
>(
  INTERACTIVE_WORKLOAD_QUEUE,
  {
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
  }
);

export const batchWorkloadQueue = new Queue<
  WorkloadJobData,
  WorkloadJobResult
>(
  BATCH_WORKLOAD_QUEUE,
  {
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
  }
);

export const waitForWorkloadQueuesReady =
  async (): Promise<void> => {
    await Promise.all([
      interactiveWorkloadQueue.waitUntilReady(),
      batchWorkloadQueue.waitUntilReady()
    ]);
  };

export const closeWorkloadQueues =
  async (): Promise<void> => {
    await Promise.allSettled([
      interactiveWorkloadQueue.close(),
      batchWorkloadQueue.close()
    ]);
  };
```

### Why are there two queues?

They provide separate waiting lists and independent queue-level configuration.

A large backlog in `workload-batch` does not become a backlog in `workload-interactive`.

However, both queues still use the same Redis deployment. If Redis becomes overloaded or unavailable, both workloads can be affected.

### Why use the same retry configuration?

For this exercise, both workloads use the same default retry policy.

In a production system, interactive jobs and batch jobs might require different retry delays, retention policies, or failure-handling rules.

Different policies should reflect actual business requirements.

---

## 7. Implement the Routing Policy

The routing policy should be pure: it receives a workload type and returns the queue name.

It must not connect to Redis, enqueue jobs, or send HTTP responses.

**File: `src/services/workload-routing.policy.ts`**

**Action: CREATE this file.**

```ts
import {
  INTERACTIVE_WORKLOAD_QUEUE,
  BATCH_WORKLOAD_QUEUE
} from "../queues/workload.queue-names.js";

import type {
  WorkloadType
} from "../queues/jobs/workload.job.js";

export const resolveWorkloadQueue = (
  workloadType: WorkloadType
): string => {
  switch (workloadType) {
    case "interactive":
      return INTERACTIVE_WORKLOAD_QUEUE;

    case "batch":
      return BATCH_WORKLOAD_QUEUE;

    default: {
      const exhaustiveCheck: never = workloadType;

      throw new Error(
        `Unsupported workload type: ${exhaustiveCheck}`
      );
    }
  }
};
```

### Understand the exhaustive check

The `never` assignment helps TypeScript detect missing cases if the `WorkloadType` union changes.

For example, suppose we add:

```ts
type WorkloadType =
  | "interactive"
  | "batch"
  | "scheduled";
```

TypeScript will report an error until the routing policy handles `"scheduled"`.

This makes routing changes more visible during development.

### Why not route based on the message?

Avoid rules such as:

```ts
if (message.includes("batch")) {
  // ...
}
```

The content of a message is not a reliable representation of the business workload.

Use explicit request fields, validated against known values.

---

## 8. Implement the Routing Service

The service creates the job payload and sends it to the appropriate queue.

### 8.1 Create the service

**File: `src/services/workload-routing.service.ts`**

**Action: CREATE this file.**

```ts
import { randomUUID } from "node:crypto";

import {
  interactiveWorkloadQueue,
  batchWorkloadQueue
} from "../queues/workload.queues.js";

import type {
  WorkloadJobData,
  WorkloadType
} from "../queues/jobs/workload.job.js";

import {
  resolveWorkloadQueue
} from "./workload-routing.policy.js";

const MAX_MESSAGE_LENGTH = 500;

export interface SubmitWorkloadInput {
  workloadType: WorkloadType;
  message: string;
}

export interface SubmitWorkloadResult {
  workloadId: string;
  jobId: string;
  workloadType: WorkloadType;
  queueName: string;
}

export const submitWorkload = async (
  input: SubmitWorkloadInput
): Promise<SubmitWorkloadResult> => {
  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError(
      `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
    );
  }

  const queueName = resolveWorkloadQueue(
    input.workloadType
  );

  const workloadId = randomUUID();

  const data: WorkloadJobData = {
    workloadId,
    workloadType: input.workloadType,
    message: input.message.trim(),
    submittedAt: new Date().toISOString()
  };

  const queue =
    input.workloadType === "interactive"
      ? interactiveWorkloadQueue
      : batchWorkloadQueue;

  const job = await queue.add(
    "process-workload",
    data
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return {
    workloadId,
    jobId: job.id,
    workloadType: input.workloadType,
    queueName
  };
};
```

### Understand the service

The service has four responsibilities:

1. Validate the message.
2. Resolve the queue name.
3. Build a typed job payload.
4. Enqueue the job and return its identifiers.

The routing policy remains separate from the side effect of enqueueing.

### Why return both IDs?

`workloadId` is an application-level identifier.

`jobId` is the identifier assigned by BullMQ.

The two identifiers have different purposes and should not be treated as interchangeable.

### Why does the service choose the queue explicitly?

The conditional is intentionally simple for two workloads.

If your platform eventually has many workload types, you can introduce a typed queue registry or strategy map to avoid a long conditional.

Do not add unnecessary abstraction before the routing rules justify it.

---

## 9. Implement the Workers

We need two independent workers.

The processing logic is similar, but each worker consumes only its own queue.

### 9.1 Create the interactive worker

**File: `src/workers/interactive-workload.worker.ts`**

**Action: CREATE this file.**

```ts
import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  INTERACTIVE_WORKLOAD_QUEUE
} from "../queues/workload.queue-names.js";

import type {
  WorkloadJobData,
  WorkloadJobResult
} from "../queues/jobs/workload.job.js";

import { logger } from "../logging/logger.js";

export const interactiveWorkloadWorker =
  new Worker<
    WorkloadJobData,
    WorkloadJobResult
  >(
    INTERACTIVE_WORKLOAD_QUEUE,
    async (job): Promise<WorkloadJobResult> => {
      const processedMessage =
        job.data.message.trim().toLowerCase();

      const result: WorkloadJobResult = {
        workloadId: job.data.workloadId,
        workloadType: job.data.workloadType,
        originalMessage: job.data.message,
        processedMessage,
        processedAt: new Date().toISOString()
      };

      logger.info(
        "Interactive workload completed",
        {
          workloadId: result.workloadId,
          jobId: job.id,
          queue: INTERACTIVE_WORKLOAD_QUEUE
        }
      );

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 10
    }
  );
```

### 9.2 Create the batch worker

**File: `src/workers/batch-workload.worker.ts`**

**Action: CREATE this file.**

```ts
import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  BATCH_WORKLOAD_QUEUE
} from "../queues/workload.queue-names.js";

import type {
  WorkloadJobData,
  WorkloadJobResult
} from "../queues/jobs/workload.job.js";

import { logger } from "../logging/logger.js";

export const batchWorkloadWorker =
  new Worker<
    WorkloadJobData,
    WorkloadJobResult
  >(
    BATCH_WORKLOAD_QUEUE,
    async (job): Promise<WorkloadJobResult> => {
      const processedMessage =
        job.data.message.trim().toLowerCase();

      const result: WorkloadJobResult = {
        workloadId: job.data.workloadId,
        workloadType: job.data.workloadType,
        originalMessage: job.data.message,
        processedMessage,
        processedAt: new Date().toISOString()
      };

      logger.info(
        "Batch workload completed",
        {
          workloadId: result.workloadId,
          jobId: job.id,
          queue: BATCH_WORKLOAD_QUEUE
        }
      );

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 2
    }
  );
```

### Understand the concurrency settings

| Worker | Concurrency |
|---|---:|
| Interactive worker | 10 |
| Batch worker | 2 |

These settings control how many jobs each worker can process concurrently.

They are not guaranteed processing rates.

For example, concurrency 10 does not mean ten jobs will finish every second. The actual throughput depends on processing duration, CPU, I/O, Redis performance, and other bottlenecks.

### Why does each worker have its own queue?

The interactive worker cannot accidentally consume jobs from the batch queue, and the batch worker cannot consume interactive jobs.

This is the central isolation property of the design.

### Important limitation

The two workers currently execute very similar, lightweight processing logic.

That makes the example easy to verify, but it does not demonstrate real latency isolation under CPU saturation. Later, you can give the batch worker its own heavier processing function and measure how that affects the system.

---

## 10. Create the API Routes

**File: `src/routes/workload.routes.ts`**

**Action: CREATE this file.**

```ts
import { Router } from "express";

import type {
  WorkloadType
} from "../queues/jobs/workload.job.js";

import {
  submitWorkload
} from "../services/workload-routing.service.js";

export const workloadRoutes = Router();

const MAX_MESSAGE_LENGTH = 500;

workloadRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const workloadType: unknown =
        req.body?.workloadType;

      const message: unknown =
        req.body?.message;

      if (
        workloadType !== "interactive" &&
        workloadType !== "batch"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_WORKLOAD_TYPE",
            message:
              "workloadType must be interactive or batch"
          }
        });
        return;
      }

      if (
        typeof message !== "string" ||
        message.trim().length === 0 ||
        message.length > MAX_MESSAGE_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
          }
        });
        return;
      }

      const result = await submitWorkload({
        workloadType: workloadType as WorkloadType,
        message
      });

      res.status(202).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);
```

### Why validate the workload type at the HTTP boundary?

The client sends untrusted data.

Even though TypeScript restricts the `WorkloadType` type inside our code, it cannot guarantee that an HTTP request contains a valid value.

We therefore validate the runtime value before passing it into the service.

### Why return HTTP 202?

The endpoint submits asynchronous work.

`202 Accepted` means the job was accepted for processing, not that the worker has finished.

We return the queue name so that the routing decision is visible during development and troubleshooting.

---

## 11. Register the Route

**File: `src/app.ts`**

**Action: MODIFY this file. Do not replace the complete file.**

### Step 1: Add the import

Add this alongside your existing route imports.

```ts
import {
  workloadRoutes
} from "./routes/workload.routes.js";
```

### Step 2: Register the endpoint

Add this alongside your other route registrations.

```ts
app.use(
  "/demo/workloads",
  workloadRoutes
);
```

Keep the existing application structure and middleware order.

The effective order should still ensure that:

1. JSON request bodies are parsed.
2. Existing request ID, logging, and security middleware remain in place.
3. Routes are registered before the not-found middleware.
4. The error middleware remains last.

Do not duplicate `express.json()` or remove existing routes.

The endpoint will be:

```text
POST http://localhost:3000/demo/workloads
```

---

## 12. Integrate Worker Lifecycle

Your existing `src/workers.ts` already manages the demo, external API, fan-out, pipeline, and parent–child workers.

We will add the new resources to that lifecycle rather than starting a separate process.

### 12.1 Add imports

**File: `src/workers.ts`**

**Action: MODIFY this file by adding these imports alongside your existing worker imports.**

```ts
import {
  interactiveWorkloadWorker
} from "./workers/interactive-workload.worker.js";

import {
  batchWorkloadWorker
} from "./workers/batch-workload.worker.js";

import {
  closeWorkloadQueues,
  waitForWorkloadQueuesReady
} from "./queues/workload.queues.js";
```

### 12.2 Add queue readiness

Inside your existing `start()` function, add this after your existing queue readiness checks.

**File: `src/workers.ts`**

**Action: MODIFY the existing `start()` function.**

```ts
await waitForWorkloadQueuesReady();

await Promise.all([
  interactiveWorkloadWorker.waitUntilReady(),
  batchWorkloadWorker.waitUntilReady()
]);
```

Do not create a second `start()` function.

Preserve all existing readiness checks.

### 12.3 Add startup failure cleanup

Your existing startup `catch` block uses `Promise.allSettled()` to close resources.

Add the new workers and queues to that existing cleanup array.

**File: `src/workers.ts`**

**Action: MODIFY the existing cleanup array.**

```ts
interactiveWorkloadWorker.close(),
batchWorkloadWorker.close(),
closeWorkloadQueues()
```

Keep the cleanup entries for all previously registered workers, queue events, fan-out resources, pipeline resources, and parent–child resources.

`Promise.allSettled()` allows the remaining cleanup operations to be attempted even if one operation rejects.

### 12.4 Add graceful shutdown

Inside the existing `shutdown()` function, add the two workers to the existing worker-close operation.

**File: `src/workers.ts`**

**Action: MODIFY the existing worker-close array.**

```ts
interactiveWorkloadWorker.close(),
batchWorkloadWorker.close()
```

After the worker-close operation, add the queue cleanup alongside your existing queue-resource cleanup.

**File: `src/workers.ts`**

**Action: MODIFY the existing shutdown sequence.**

```ts
await closeWorkloadQueues();
```

The intended shutdown order is:

1. Close all existing and new workers.
2. Close queue-event listeners.
3. Close fan-out, pipeline, parent–child, and other queue resources.
4. Close the new workload queues.
5. Log completion and set the exit code.

Preserve your existing shutdown guard, error handling, and cleanup calls.

Do not duplicate queue-close calls if you already have a shared cleanup function that closes these exact resources.

---

## 13. Unit Tests

We'll test the routing policy independently of Redis.

This verifies the business rule: each supported workload type maps to the intended queue.

### 13.1 Create the test file

**File: `tests/workload-routing.policy.test.ts`**

**Action: CREATE this file.**

```ts
import {
  describe,
  expect,
  it
} from "vitest";

import {
  resolveWorkloadQueue
} from "../src/services/workload-routing.policy.js";

import {
  INTERACTIVE_WORKLOAD_QUEUE,
  BATCH_WORKLOAD_QUEUE
} from "../src/queues/workload.queue-names.js";

describe("resolveWorkloadQueue", () => {
  it("routes interactive workloads to the interactive queue", () => {
    expect(
      resolveWorkloadQueue("interactive")
    ).toBe(INTERACTIVE_WORKLOAD_QUEUE);
  });

  it("routes batch workloads to the batch queue", () => {
    expect(
      resolveWorkloadQueue("batch")
    ).toBe(BATCH_WORKLOAD_QUEUE);
  });
});
```

### 13.2 Run the targeted test

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/workload-routing.policy.test.ts
```

Expected: both tests pass.

### 13.3 Run the full suite

**Terminal: PowerShell**

```powershell
npm run test:run
```

Expected: the new tests pass and existing tests remain green.

If the full suite fails, inspect the failing test and its error before modifying unrelated code.

---

## 14. Build and Run

Run the following commands from your project directory:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

### Step 1: Build the project

**Terminal: PowerShell**

```powershell
npm run build
```

Expected: TypeScript compiles without errors.

If you encounter an error, fix it before starting the application.

### Step 2: Start the API

**Terminal 1: PowerShell**

```powershell
npm run dev
```

Wait for the server to finish starting.

### Step 3: Start the workers

**Terminal 2: PowerShell**

```powershell
npm run dev:worker
```

Wait until the existing and new workers are ready.

You should have:

- The API process.
- The existing worker process, now including the interactive and batch workers.

Do not start another worker process just for these two queues.

---

## 15. API Verification

### 15.1 Submit an interactive workload

**Terminal: PowerShell**

```powershell
$body = @{
    workloadType = "interactive"
    message = "Redis connection health"
} | ConvertTo-Json

$interactiveResponse = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/workloads" `
    -ContentType "application/json" `
    -Body $body

$interactiveResponse
```

Expected response structure:

```json
{
  "success": true,
  "data": {
    "workloadId": "generated-workload-id",
    "jobId": "generated-job-id",
    "workloadType": "interactive",
    "queueName": "workload-interactive"
  }
}
```

The IDs are illustrative. Your application will generate actual identifiers.

Verify that the returned queue name is `workload-interactive`.

### 15.2 Submit a batch workload

**Terminal: PowerShell**

```powershell
$body = @{
    workloadType = "batch"
    message = "Recalculate service metrics"
} | ConvertTo-Json

$batchResponse = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/workloads" `
    -ContentType "application/json" `
    -Body $body

$batchResponse
```

Expected: the response reports the `workload-batch` queue.

### 15.3 Verify the worker logs

Check the worker terminal.

For the interactive request, the logs should identify:

```text
workload-interactive
```

For the batch request, the logs should identify:

```text
workload-batch
```

This confirms that each worker processes jobs from its own queue.

### 15.4 Submit an unsupported workload type

**Terminal: PowerShell**

```powershell
$body = @{
    workloadType = "urgent"
    message = "Process this job"
} | ConvertTo-Json

try {
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://localhost:3000/demo/workloads" `
        -ContentType "application/json" `
        -Body $body
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `400 Bad Request`.

The API must not enqueue the job into an arbitrary queue.

### 15.5 Submit a blank message

**Terminal: PowerShell**

```powershell
$body = @{
    workloadType = "interactive"
    message = "   "
} | ConvertTo-Json

try {
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://localhost:3000/demo/workloads" `
        -ContentType "application/json" `
        -Body $body
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `400 Bad Request`.

No job should be enqueued.

---

## 16. Intentional Break → Understand → Fix

### Break 1: Route interactive work to the batch queue

**File: `src/services/workload-routing.policy.ts`**

Temporarily change the interactive case so that it returns the batch queue.

The incorrect implementation is conceptually:

```ts
case "interactive":
  return BATCH_WORKLOAD_QUEUE;
```

Run the targeted test:

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/workload-routing.policy.test.ts
```

Expected: the interactive routing test fails.

### Understand the failure

The routing policy is a business rule.

If an interactive job is accidentally routed to the batch queue, it will be processed by the batch worker pool instead of the interactive worker pool.

The code may still compile and the job may still complete, but the isolation policy is broken.

This is why routing tests are valuable even when the application has no TypeScript errors.

### Fix 1

Restore the correct mapping.

**File: `src/services/workload-routing.policy.ts`**

```ts
case "interactive":
  return INTERACTIVE_WORKLOAD_QUEUE;
```

Run the targeted test again.

Expected: both tests pass.

### Break 2: Use the wrong queue name in the interactive worker

**File: `src/workers/interactive-workload.worker.ts`**

Temporarily configure the worker to consume `BATCH_WORKLOAD_QUEUE` instead of `INTERACTIVE_WORKLOAD_QUEUE`.

Start the worker process and submit an interactive request.

You may observe that the job remains waiting in `workload-interactive` because no worker is consuming that queue.

The exact visible result depends on whether another process is already consuming the queue.

### Understand the failure

A producer and its intended worker must agree on the queue name.

Routing a job to one queue does not make a worker listening to another queue consume it.

This kind of configuration error can produce a healthy API while jobs silently accumulate in a queue with no active worker.

### Fix 2

Restore the interactive worker's queue constant.

Then restart the worker process and submit a new interactive job.

Verify that it is processed.

### Final verification

**Terminal: PowerShell**

```powershell
npm run build
npm run test:run
```

Then submit one interactive workload and one batch workload.

Verify that each job reaches the correct worker.

---

## 17. Production Trade-offs

### 17.1 Separate queues do not guarantee complete resource isolation

Our two queues still share the same Redis deployment.

They may also share:

- The same Node.js process.
- CPU and memory.
- Network connections.
- PostgreSQL connection pools.
- External services.
- Container resource limits.

A CPU-heavy batch job can still consume CPU that an interactive workload needs, even if the jobs belong to different queues.

For stronger isolation, consider separate worker processes or containers with explicit CPU and memory limits.

### 17.2 Concurrency is not throughput

Interactive concurrency 10 and batch concurrency 2 do not directly specify jobs per second.

A high concurrency setting can improve throughput for I/O-bound work. For CPU-heavy synchronous work, increasing concurrency may not improve performance and can make contention worse.

Measure actual processing time and resource usage.

### 17.3 Separate worker processes may be necessary

This lecture registers both workers in your existing worker process.

That provides queue-level and worker-pool isolation, but not complete process-level isolation.

For stronger operational isolation, deploy interactive and batch workers separately, each with its own startup command, scaling policy, and container resource limits.

That would be a later architectural change, not something to implement by duplicating your current worker lifecycle blindly.

### 17.4 Routing policy should remain explicit

As workload categories grow, you might need routing rules based on:

- Tenant.
- Service tier.
- Job cost.
- Data sensitivity.
- Deadline.
- External dependency.
- Operational priority.

Keep these rules deterministic and testable.

Avoid making routing decisions from arbitrary message text.

### 17.5 Rate limiting and concurrency solve different problems

Concurrency controls how many jobs a worker processes at once.

Rate limiting controls the rate at which jobs are allowed to be processed.

An interactive queue with high concurrency can still overload a downstream service if each job makes an external request.

If your workers call rate-limited external APIs, retain the appropriate queue-level or worker-level rate limits.

### 17.6 Monitor queue depth and job age

Queue depth alone is not enough.

A queue with ten jobs waiting for ten seconds may be more concerning than a queue with a thousand jobs waiting for a few milliseconds.

Useful metrics include:

- Waiting jobs.
- Active jobs.
- Failed jobs.
- Completed jobs.
- Oldest waiting-job age.
- Processing duration.
- Retry count.
- Worker availability.

Your existing queue monitoring implementation is a useful foundation for adding these metrics.

### 17.7 Avoid creating too many queues without a reason

Each queue adds configuration, monitoring, lifecycle, and operational overhead.

Create separate queues when workloads genuinely require different policies or resource allocation.

Do not create a queue for every individual job type by default.

---

## 18. Final Folder Structure

The following shows the files relevant to this lecture and nearby existing features.

```text
production-intelligence-platform/
├── src/
│   ├── queues/
│   │   ├── jobs/
│   │   │   └── workload.job.ts
│   │   ├── workload.queue-names.ts
│   │   └── workload.queues.ts
│   ├── services/
│   │   ├── workload-routing.policy.ts
│   │   └── workload-routing.service.ts
│   ├── workers/
│   │   ├── interactive-workload.worker.ts
│   │   └── batch-workload.worker.ts
│   ├── routes/
│   │   └── workload.routes.ts
│   ├── app.ts
│   └── workers.ts
└── tests/
    └── workload-routing.policy.test.ts
```

This is a focused view, not the complete repository tree. Your existing queue, pipeline, fan-out, and parent–child files remain in place.

---

## 19. Success Criteria

Before moving forward, verify every item.

- [ ] The workload types are explicitly defined.
- [ ] Interactive and batch queue names are centralized.
- [ ] Both queues use the existing BullMQ connection factory.
- [ ] The routing policy maps each workload to the correct queue.
- [ ] The service validates messages before enqueueing.
- [ ] The API rejects unsupported workload types.
- [ ] The interactive worker consumes only the interactive queue.
- [ ] The batch worker consumes only the batch queue.
- [ ] Worker concurrency is configured independently.
- [ ] Both workers participate in startup readiness checks.
- [ ] Both workers participate in startup failure cleanup.
- [ ] Both workers and queues participate in graceful shutdown.
- [ ] The routing policy tests pass.
- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes.
- [ ] Interactive jobs reach the interactive worker.
- [ ] Batch jobs reach the batch worker.
- [ ] Both intentional-break exercises have been fixed and re-tested.

### What you learned

You now have an explicit routing policy and separate worker pools for two workload classes.

The central lesson is:

**Routing decides where work goes. Isolation determines which processing capacity handles it.**

Separate queues are a useful first step, but real production isolation may also require separate processes, container limits, rate limits, monitoring, and workload-specific scaling.

**Next lecture — Module 2, Lecture 20: Queue Sharding & Partitioning Strategies.** We'll examine how to distribute high-volume workloads across multiple queues without losing routing consistency or making operations unnecessarily complicated.