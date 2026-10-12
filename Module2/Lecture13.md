# Module 2 — Lecture 13: BullMQ Rate Limiting & External Service Protection

## Table of Contents

1. Learning objectives
2. Understand rate limiting
3. Architecture
4. Create the external API job types
5. Create the external API queue
6. Create the producer
7. Create the rate-limited worker
8. Create the API routes
9. Register the routes
10. Register the worker lifecycle
11. Build and start the application
12. Test rate limiting
13. Break the implementation intentionally
14. Fix and verify
15. Production considerations
16. Final folder structure
17. Completion checklist

---

## 1. Learning Objectives

By the end of this lecture, you should understand:

- The difference between rate limiting and concurrency.
- How BullMQ's worker limiter protects an external API.
- Why a queue can contain waiting jobs even when workers are healthy.
- How to verify that jobs are processed within a configured rate.
- Why rate limiting must be designed across all workers, not just one process.
- Why rate limiting and retry policies solve different problems.

We will create an isolated `external-api` queue.

We will simulate an external service instead of calling a real provider.

### Our rate limit

| Setting | Value |
|---|---:|
| Maximum jobs | 3 |
| Duration | 5,000 ms |
| Worker concurrency | 5 |
| Jobs submitted in the main test | 8 |

The intended behavior is that BullMQ starts no more than three jobs per five-second rate-limit window.

This is a demonstration configuration, not a recommendation for a real provider. Real limits must follow the provider's documented quota.

---

## 2. Understand Rate Limiting

### 2.1 Rate limiting

Rate limiting controls how many jobs can start processing within a time window.

For example:

```ts
limiter: {
  max: 3,
  duration: 5000
}
```

This configures a maximum of three jobs per 5,000 milliseconds for the queue.

### 2.2 Concurrency

Concurrency controls how many jobs a worker can process simultaneously.

For example:

```ts
concurrency: 5
```

This allows a worker to process up to five jobs concurrently, subject to the rate limiter and other constraints.

### 2.3 Why they are different

Imagine each external API call takes 10 seconds.

- Concurrency of 5 allows up to five jobs to be active at once.
- A rate limit of 3 jobs per 5 seconds controls how frequently jobs start.
- Neither setting means that the provider will accept every request.
- The external service can still respond with HTTP 429.

**Important:** A rate limit is not a substitute for handling timeouts, network failures, provider errors, or idempotency.

---

## 3. Architecture

The request flow will be:

```text
Express API
    |
    v
External API Producer
    |
    v
Redis / BullMQ Queue
    |
    v
Rate-Limited Worker
    |
    v
Simulated External API
```

We are keeping this queue separate from the existing `demo-job` queue.

### Files created

```text
src/
├── queues/
│   ├── external-api.queue.ts
│   └── jobs/
│       └── external-api.job.ts
├── queues/
│   └── producers/
│       └── external-api.producer.ts
├── workers/
│   └── external-api.worker.ts
└── routes/
    └── external-api.routes.ts
```

We will also make small, explicitly identified changes to `src/app.ts` and `src/workers.ts`.

---

## 4. Create the External API Job Types

### File: `src/queues/jobs/external-api.job.ts`

**Action:** Create this file.

```ts
export interface ExternalApiJobData {
  requestId: string;
  message: string;
}

export interface ExternalApiJobResult {
  requestId: string;
  processedAt: string;
  success: boolean;
}
```

### Explanation

`requestId` identifies a submitted request.

`message` represents the payload we intend to send to an external service.

`ExternalApiJobResult` describes the successful result stored by BullMQ.

In a real integration, do not put API keys, passwords, or access tokens in job data. Use environment configuration or a secrets manager.

---

## 5. Create the External API Queue

### File: `src/queues/external-api.queue.ts`

**Action:** Create this file.

```ts
import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import type {
  ExternalApiJobData,
  ExternalApiJobResult
} from "./jobs/external-api.job.js";

export const EXTERNAL_API_QUEUE_NAME =
  "external-api";

export const EXTERNAL_API_RATE_LIMIT = {
  max: 3,
  duration: 5000
} as const;

export const externalApiQueue = new Queue<
  ExternalApiJobData,
  ExternalApiJobResult
>(
  EXTERNAL_API_QUEUE_NAME,
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
```

### Important details

1. This queue uses your existing `createBullMQConnection` factory.
2. We do not specify `limiter` on the queue. The worker limiter is configured on the worker.
3. The retry policy applies to genuine processing failures.
4. Rate limiting is not itself a failed attempt.

Do not create a second Redis client just for this queue.

---

## 6. Create the Producer

### File: `src/queues/producers/external-api.producer.ts`

**Action:** Create this file.

```ts
import { randomUUID } from "node:crypto";

import {
  externalApiQueue
} from "../external-api.queue.js";

import type {
  ExternalApiJobData
} from "../jobs/external-api.job.js";

export const enqueueExternalApiRequest =
  async (
    message: string
  ) => {
    const data: ExternalApiJobData = {
      requestId: randomUUID(),
      message
    };

    const job = await externalApiQueue.add(
      "external-api-request",
      data
    );

    return {
      jobId: String(job.id),
      requestId: data.requestId,
      message: data.message
    };
  };

export const enqueueExternalApiBatch =
  async (
    count: number
  ) => {
    const jobs = Array.from(
      { length: count },
      (_, index) => ({
        name: "external-api-request",
        data: {
          requestId: randomUUID(),
          message: `Rate-limit test request ${index + 1}`
        } satisfies ExternalApiJobData
      })
    );

    const addedJobs =
      await externalApiQueue.addBulk(jobs);

    return addedJobs.map((job) => ({
      jobId: String(job.id),
      requestId: job.data.requestId
    }));
  };
```

### Why use `addBulk()`?

It submits multiple jobs through the queue API without requiring a separate `add()` call for every item.

Bulk insertion does not bypass the worker's rate limiter. Workers still process jobs according to their configured limits.

---

## 7. Create the Rate-Limited Worker

### File: `src/workers/external-api.worker.ts`

**Action:** Create this file.

```ts
import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  EXTERNAL_API_QUEUE_NAME,
  EXTERNAL_API_RATE_LIMIT
} from "../queues/external-api.queue.js";

import type {
  ExternalApiJobData,
  ExternalApiJobResult
} from "../queues/jobs/external-api.job.js";

import {
  logger
} from "../logging/logger.js";

const simulateExternalApiRequest =
  async (
    data: ExternalApiJobData
  ): Promise<ExternalApiJobResult> => {
    // Simulate a short external API request.
    // Replace this function with a real HTTP client later.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    return {
      requestId: data.requestId,
      processedAt: new Date().toISOString(),
      success: true
    };
  };

export const externalApiWorker =
  new Worker<
    ExternalApiJobData,
    ExternalApiJobResult
  >(
    EXTERNAL_API_QUEUE_NAME,

    async (job) => {
      logger.info(
        "External API job started",
        {
          queue: EXTERNAL_API_QUEUE_NAME,
          jobId: job.id,
          requestId: job.data.requestId
        }
      );

      const result =
        await simulateExternalApiRequest(
          job.data
        );

      logger.info(
        "External API job completed",
        {
          queue: EXTERNAL_API_QUEUE_NAME,
          jobId: job.id,
          requestId: result.requestId,
          processedAt: result.processedAt
        }
      );

      return result;
    },

    {
      connection:
        createBullMQConnection(null),

      concurrency: 5,

      limiter: {
        max:
          EXTERNAL_API_RATE_LIMIT.max,

        duration:
          EXTERNAL_API_RATE_LIMIT.duration
      }
    }
  );

externalApiWorker.on(
  "failed",
  (job, error) => {
    logger.error(
      "External API job failed",
      {
        queue: EXTERNAL_API_QUEUE_NAME,
        jobId: job?.id,
        error: error.message
      }
    );
  }
);

externalApiWorker.on(
  "error",
  (error) => {
    logger.error(
      "External API worker error",
      {
        queue: EXTERNAL_API_QUEUE_NAME,
        error: error.message
      }
    );
  }
);
```

### Why is the worker connection different?

Your queue connection uses:

```ts
createBullMQConnection(1)
```

Your worker connection uses:

```ts
createBullMQConnection(null)
```

This preserves the connection configuration already established in your project for producers and workers.

Do not change the connection factory's return type to `RedisOptions`. Your project previously encountered a TypeScript connection-options mismatch when using an explicit ioredis type.

### Why does the worker use `concurrency: 5`?

It allows multiple requests to be processed concurrently, but the rate limiter restricts how frequently jobs can start.

Concurrency and rate limiting work together; they do not mean the same thing.

---

## 8. Create the API Routes

### File: `src/routes/external-api.routes.ts`

**Action:** Create this file.

```ts
import { Router } from "express";

import {
  externalApiQueue
} from "../queues/external-api.queue.js";

import {
  enqueueExternalApiBatch,
  enqueueExternalApiRequest
} from "../queues/producers/external-api.producer.js";

const router = Router();

router.post(
  "/demo/external-api/jobs",
  async (req, res, next) => {
    try {
      const message = req.body?.message;

      if (
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_MESSAGE",
            message:
              "message must be a non-empty string"
          }
        });

        return;
      }

      const job =
        await enqueueExternalApiRequest(
          message.trim()
        );

      res.status(202).json({
        success: true,
        data: job
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/demo/external-api/jobs/bulk",
  async (req, res, next) => {
    try {
      const count = req.body?.count;

      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 20
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_COUNT",
            message:
              "count must be an integer between 1 and 20"
          }
        });

        return;
      }

      const jobs =
        await enqueueExternalApiBatch(count);

      res.status(202).json({
        success: true,
        data: {
          submitted: jobs.length,
          jobs
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/monitoring/queues/external-api",
  async (_req, res, next) => {
    try {
      const counts =
        await externalApiQueue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "completed",
          "failed"
        );

      res.status(200).json({
        success: true,
        data: {
          queue: "external-api",
          counts: {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0
          },
          rateLimit: {
            max: 3,
            durationMs: 5000
          },
          sampledAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

### Why return HTTP 202?

`202 Accepted` means the application accepted the request for asynchronous processing. It does not mean the external operation has already completed.

The monitoring endpoint reports a snapshot of queue counts. It is not a guarantee that all counts will remain unchanged after the response.

---

## 9. Register the Routes

### File: `src/app.ts`

**Action:** Add this import with your other route imports.

```ts
import externalApiRoutes
  from "./routes/external-api.routes.js";
```

**Action:** Register the route before your not-found and error middleware.

```ts
app.use(externalApiRoutes);
```

Keep your existing middleware ordering and other route registrations intact.

Do not replace the entire `app.ts` file with a shortened example. Your existing security, request ID, request logging, and error middleware must remain in place.

---

## 10. Register the Worker Lifecycle

The new worker must start with your worker process and close during graceful shutdown.

### File: `src/workers.ts`

**Action 1:** Add this import alongside your existing worker imports.

```ts
import {
  externalApiWorker
} from "./workers/external-api.worker.js";
```

**Action 2:** In your existing startup function, after your existing worker and QueueEvents initialization, add:

```ts
await externalApiWorker.waitUntilReady();
```

#### Final code
```
import {
  demoWorker
} from "./workers/demo.worker.js";

import {
  startDemoQueueEvents,
  closeDemoQueueEvents
} from "./queues/demo.queue-events.js";

import {
  logger
} from "./logging/logger.js";

import {
  externalApiWorker
} from "./workers/external-api.worker.js";

let isShuttingDown = false;

const start = async (): Promise<void> => {
  try {
    await startDemoQueueEvents();

    await demoWorker.waitUntilReady();

    await externalApiWorker.waitUntilReady();

    logger.info("Worker process started");
  } catch (error) {
    logger.error("Worker process startup failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });

    await Promise.allSettled([
      demoWorker.close(),
      externalApiWorker.close(),
      closeDemoQueueEvents()
    ]);

    process.exitCode = 1;
  }
};

const shutdown = async (
  signal: string
): Promise<void> => {
  if (isShuttingDown) {
    logger.warn("Worker shutdown already in progress", {
      signal
    });

    return;
  }

  isShuttingDown = true;

  logger.info("Worker shutdown started", {
    signal
  });

  try {
    await Promise.all([
      demoWorker.close(),
      externalApiWorker.close(),
      closeDemoQueueEvents()
    ]);

    logger.info("Worker shutdown completed");

    process.exitCode = 0;
  } catch (error) {
    logger.error("Worker shutdown failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });

    process.exitCode = 1;
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start();
```

This ensures the worker's Redis connection is ready before startup is considered successful.

**Action 3:** In your existing shutdown function, close the new worker.

Add this line to the existing shutdown sequence:

```ts
await externalApiWorker.close();
```

Place it before the final shutdown-completed log.

Preserve the existing `demoWorker`, QueueEvents, signal handlers, error handling, and idempotent shutdown guard. Do not add duplicate SIGINT/SIGTERM handlers.

---

## 11. Build and Start the Application

Open PowerShell in the project directory:

```powershell
cd D:\Production-Intelligence-Incident-Platform\production-intelligence-platform
```

### Step 1: Build

```powershell
npm run build
```

Expected result: TypeScript compiles without errors.

If compilation fails, fix that error before continuing.

### Step 2: Start dependencies

```powershell
docker compose up -d postgres redis
```

Check their status:

```powershell
docker compose ps
```

Make sure Redis is healthy and reachable.

### Step 3: Start the API

Open terminal 1:

```powershell
npm run dev
```

### Step 4: Start the workers

Open terminal 2:

```powershell
npm run dev:worker
```

The worker process should initialize the existing demo worker, QueueEvents, and the new external API worker.

---

## 12. Test Rate Limiting

### Test A: Validate request input

Run in PowerShell:

```powershell
$body = @{
  count = 0
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/external-api/jobs/bulk" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_COUNT`.

PowerShell may throw an exception for a non-2xx HTTP response. That is expected for this validation test.

### Test B: Submit eight jobs

```powershell
$body = @{
  count = 8
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/external-api/jobs/bulk" `
  -ContentType "application/json" `
  -Body $body
```

Expected result:

- HTTP 202.
- `submitted` equals 8.
- The response contains the generated job IDs.

### Test C: Inspect queue counts

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/monitoring/queues/external-api"
```

Inspect:

- `waiting`
- `active`
- `completed`
- `failed`

Because the jobs complete quickly, the waiting count may drop before you inspect it. A single queue-count snapshot is not sufficient to prove the rate limit.

### Test D: Observe worker timestamps

Look at the worker logs for:

```text
External API job started
External API job completed
```

Compare the timestamps of the **start** events.

The limiter controls job starts, not the time at which jobs finish. Since the processor is simulated, no actual provider requests are made.

To test reliably, submit several batches and record the start timestamps. Confirm that starts are throttled according to the configured window, rather than assuming that every job will start at a fixed interval.

**Important:** Rate-limit windows and job execution are asynchronous. Do not expect an exact five-second gap between every pair of jobs.

---

## 13. Break the Implementation Intentionally

We now verify that the worker limiter actually matters.

### Break A: Remove the limiter

File: `src/workers/external-api.worker.ts`

Temporarily replace the worker's options:

```ts
{
  connection:
    createBullMQConnection(null),

  concurrency: 5

  // Intentionally missing limiter.
}
```

Restart the worker and submit eight jobs again.

Expected behavior:

- The worker can process jobs without the configured three-per-five-second restriction.
- Several jobs may start close together because concurrency is five.
- The exact timing depends on the machine and Redis scheduling.

Restore the limiter immediately after the experiment.

### Break B: Restore the limiter

File: `src/workers/external-api.worker.ts`

Ensure the options contain:

```ts
{
  connection:
    createBullMQConnection(null),

  concurrency: 5,

  limiter: {
    max: 3,
    duration: 5000
  }
}
```

Restart the worker and submit another batch.

Expected behavior: the queue again applies the configured rate limit.

### Root-cause analysis

Without the limiter, concurrency is the primary worker-level restriction in this example. Concurrency alone does not enforce a maximum number of requests per second.

With the limiter restored, BullMQ coordinates rate limiting through Redis for the queue.

The queue can therefore have waiting jobs while the worker is healthy. Waiting jobs do not automatically indicate a broken worker.

---

## 14. Fix and Verify

After the break test:

1. Restore the worker limiter.
2. Run `npm run build`.
3. Restart the worker process.
4. Submit eight jobs.
5. Observe the worker logs.
6. Inspect the queue monitoring endpoint.
7. Wait for the backlog to drain.

### Final verification commands

```powershell
npm run build
```

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/monitoring/queues/external-api"
```

Expected final state after all jobs finish and provided no jobs fail:

- `waiting` is 0.
- `active` is 0.
- `failed` is 0.
- `completed` reflects retained completed jobs, subject to the queue's retention configuration.

Do not claim the rate limiter is proven solely because the final queue is empty. Verify the start-event timing as well.

---

## 15. Production Considerations

### 15.1 What if the provider returns HTTP 429?

The static limiter is not enough if the provider changes its quota or returns `429 Too Many Requests`.

A production integration should:

1. Detect HTTP 429 responses.
2. Read `Retry-After` if the provider supplies it.
3. Apply a bounded delay to future processing.
4. Return the current job to the waiting state using BullMQ's manual rate-limiting mechanism.
5. Distinguish rate limiting from genuine job failures.
6. Record rate-limit events and metrics.

BullMQ documents a manual rate-limit mechanism using `worker.rateLimit(duration)` and the special `Worker.RateLimitError()` exception. The worker must also have limiter configuration for this validation to work. See the official guide:

https://docs.bullmq.io/guide/rate-limiting

Do not simply throw an ordinary error for every HTTP 429. An ordinary error can consume a retry attempt and cause unnecessary retries.

We will treat dynamic provider throttling as a separate advanced implementation rather than pretending the simulated API above already handles real HTTP 429 responses.

### 15.2 Multiple worker processes

The worker limiter is global for the queue, so adding more workers does not independently multiply the configured queue rate limit.

However, if multiple applications or queues call the same external provider, a separate limiter per queue may still exceed the provider's account-wide quota.

The rate-limit boundary must match the provider's actual quota boundary.

### 15.3 Idempotency

Rate limiting does not prevent duplicate external side effects.

For example, a payment request might reach the provider successfully, but the worker may crash before recording the result. Retrying without an idempotency key could create a duplicate payment.

For real external services, use provider-supported idempotency keys where available, and persist request outcomes safely.

### 15.4 Retries and backoff

Retries help with transient failures. Rate limiting controls processing frequency.

Use bounded retries and suitable backoff for transient failures. Avoid retrying permanent errors indefinitely.

### 15.5 Monitoring

A production monitoring system should measure:

- Waiting jobs and oldest waiting-job age.
- Active jobs.
- Completed and failed jobs.
- Job processing duration.
- External API latency.
- HTTP 429 count.
- Retry count.
- Provider quota utilization.
- Worker readiness and Redis connectivity.

Queue counts alone do not provide enough information to diagnose a backlog.

### 15.6 Security

Do not accept arbitrary URLs from clients and fetch them in the worker. That can introduce server-side request forgery risks.

Keep provider URLs controlled by configuration and validate request payloads before enqueuing jobs.

---

## 16. Final Folder Structure

The new files should appear as follows:

```text
src/
├── queues/
│   ├── bullmq.connection.ts
│   ├── external-api.queue.ts
│   ├── jobs/
│   │   ├── demo.job.ts
│   │   └── external-api.job.ts
│   └── producers/
│       ├── demo.producer.ts
│       └── external-api.producer.ts
├── routes/
│   └── external-api.routes.ts
├── workers/
│   ├── demo.worker.ts
│   └── external-api.worker.ts
├── app.ts
└── workers.ts
```

This is an excerpt of the relevant structure, not a replacement for your existing project folders.

---

## 17. Completion Checklist

- [ ] Created the external API job types.
- [ ] Created the separate BullMQ queue.
- [ ] Created single-job and bulk producers.
- [ ] Configured a worker limiter.
- [ ] Registered the worker in the existing lifecycle.
- [ ] Registered the API routes.
- [ ] Verified invalid request handling.
- [ ] Submitted eight jobs successfully.
- [ ] Observed rate-limited job processing.
- [ ] Removed the limiter intentionally and observed the difference.
- [ ] Restored the limiter.
- [ ] Rebuilt the project successfully.
- [ ] Verified that the backlog drained.
- [ ] Understood the difference between concurrency and rate limiting.
- [ ] Understood why real HTTP 429 handling requires additional logic.

## Success Criteria

Lecture 13 is complete only after the implementation builds, the API accepts valid requests, the worker processes jobs, the intentional break demonstrates the role of the limiter, and the restored implementation passes verification.

Do not proceed to Lecture 14 until these checks are complete.