
# Module 3 — Lecture 3: Redis Locks and Safe Lock Release in a Background Worker

## Table of Contents

1. Learning objectives
2. Architecture
3. Understand the processing flow
4. Create the job type
5. Create the queue
6. Create the producer
7. Create the worker
8. Create the API route
9. Register the route
10. Register the worker lifecycle
11. Build and test
12. Test concurrent requests
13. Break it intentionally
14. Production considerations
15. Final checklist

---

## 1. Learning Objectives

In Lecture 2, we verified that Redis can prevent two clients from acquiring the same lock simultaneously.

Now we will use that lock in a background worker.

By the end of this lecture, you will understand:

- How BullMQ workers use a distributed lock to coordinate shared resources.
- Why two different jobs can refer to the same resource.
- How to release locks safely in `finally`.
- What should happen when a lock is already held.
- How BullMQ retries jobs that cannot acquire a lock.
- Why lock expiration, worker crashes, and duplicate jobs still require careful handling.

### Prerequisites

Confirm that these files exist and your earlier lecture builds successfully:

- `src/services/distributed-lock.service.ts`
- `src/queues/bullmq.connection.ts`
- `src/redis/client.ts`

The distributed lock service must export `distributedLockService`, with `acquire(resource, ttlMs)` and `release(resource, token)` methods.

Do not create a second Redis client. Use your existing connection configuration.

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

---

## 2. Architecture

We will create a small demonstration workflow without changing your existing business features.

```text
HTTP Request
    |
    v
POST /demo/locks/worker
    |
    v
BullMQ Queue
    |
    v
Distributed Lock Worker
    |
    v
Acquire Redis Lock
    |
    +---- Lock unavailable --> Throw error --> BullMQ retry
    |
    +---- Lock acquired
              |
              v
       Simulate report work
              |
              v
       Release lock safely
              |
              v
       Job completed
```

Two jobs can have different BullMQ job IDs but use the same report ID. The Redis lock coordinates access to that shared report resource.

For this lecture, the worker simulates report processing. It does not modify your real incident or report data.

---

## 3. Understand the Processing Flow

Suppose two jobs are submitted:

```text
Job A: reportId = report-1001
Job B: reportId = report-1001
```

Both jobs attempt to acquire:

```text
lock:report:report-1001
```

The first job acquires the lock. The second cannot acquire it while the first still owns the lease.

The second job throws an error so BullMQ can retry it according to the queue's retry policy.

**Important:** A lock is not a substitute for idempotency. A retried job can still repeat an operation after a crash or an expired lease.

---

## 4. Create the Job Type

**File:** `src/queues/jobs/distributed-lock.job.ts`

**Action:** Create this file.

```ts
export interface DistributedLockJobData {
  reportId: string;
  workMs: number;
}
```

The fields mean:

| Field | Purpose |
|---|---|
| `reportId` | Identifies the shared resource |
| `workMs` | Controls how long the demonstration takes |

We will restrict `workMs` to a maximum of 25 seconds because the demonstration lock will have a 30-second TTL.

That limit is for this demonstration, not a universal production rule.

---

## 5. Create the Queue

**File:** `src/queues/distributed-lock.queue.ts`

**Action:** Create this file.

```ts
import { Queue } from "bullmq";

import { createBullMQConnection } from "./bullmq.connection.js";

import type { DistributedLockJobData } from "./jobs/distributed-lock.job.js";

export const DISTRIBUTED_LOCK_QUEUE_NAME =
  "distributed-lock-demo";

export const distributedLockQueue =
  new Queue<DistributedLockJobData>(
    DISTRIBUTED_LOCK_QUEUE_NAME,
    {
      connection: createBullMQConnection(1),

      defaultJobOptions: {
        attempts: 5,

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

### Why configure retries?

If a job cannot acquire the distributed lock, it throws an error. BullMQ can retry the job with exponential backoff.

The delays grow approximately like this:

```text
Attempt fails
    |
    v
Wait 1 second
    |
    v
Retry fails
    |
    v
Wait 2 seconds
    |
    v
Retry fails
    |
    v
Wait 4 seconds
```

Actual retry timing can vary. Retries are finite: after the configured attempts are exhausted, the job becomes failed.

A failed lock acquisition is not proof that the business operation itself failed. It means the worker could not obtain permission to enter the protected section at that time.

---

## 6. Create the Producer

**File:** `src/queues/producers/distributed-lock.producer.ts`

**Action:** Create this file.

```ts
import { distributedLockQueue } from "../distributed-lock.queue.js";

import type { DistributedLockJobData } from "../jobs/distributed-lock.job.js";

export async function enqueueDistributedLockJob(
  data: DistributedLockJobData
): Promise<string> {
  const job = await distributedLockQueue.add(
    "process-report",
    data
  );

  if (!job.id) {
    throw new Error("BullMQ did not return a job ID");
  }

  return job.id;
}
```

The producer only submits work. It does not acquire the distributed lock.

The worker acquires the lock when it begins processing the job.

This separation is important because jobs can wait in a queue for a long time before a worker picks them up.

---

## 7. Create the Worker

**File:** `src/workers/distributed-lock.worker.ts`

**Action:** Create this file.

```ts
import { Worker } from "bullmq";

import { createBullMQConnection } from "../queues/bullmq.connection.js";

import { DISTRIBUTED_LOCK_QUEUE_NAME } from "../queues/distributed-lock.queue.js";

import type { DistributedLockJobData } from "../queues/jobs/distributed-lock.job.js";

import { distributedLockService } from "../services/distributed-lock.service.js";

const LOCK_TTL_MS = 30_000;

function simulateReportWork(
  workMs: number
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, workMs);
  });
}

export const distributedLockWorker =
  new Worker<DistributedLockJobData>(
    DISTRIBUTED_LOCK_QUEUE_NAME,

    async (job) => {
      const resource = `report:${job.data.reportId}`;

      const token = await distributedLockService.acquire(
        resource,
        LOCK_TTL_MS
      );

      if (!token) {
        throw new Error(
          `Resource is locked: ${resource}`
        );
      }

      console.log(
        `[distributed-lock] Acquired resource=${resource} jobId=${job.id}`
      );

      try {
        console.log(
          `[distributed-lock] Work started resource=${resource} jobId=${job.id}`
        );

        await simulateReportWork(job.data.workMs);

        console.log(
          `[distributed-lock] Work finished resource=${resource} jobId=${job.id}`
        );

        return {
          success: true,
          reportId: job.data.reportId,
          processedAt: new Date().toISOString()
        };
      } finally {
        try {
          const released =
            await distributedLockService.release(
              resource,
              token
            );

          if (!released) {
            console.error(
              `[distributed-lock] Release rejected; ownership changed or lease expired resource=${resource} jobId=${job.id}`
            );
          } else {
            console.log(
              `[distributed-lock] Released resource=${resource} jobId=${job.id}`
            );
          }
        } catch (error) {
          console.error(
            `[distributed-lock] Release failed; lock may remain until TTL expiration resource=${resource} jobId=${job.id}`,
            error
          );
        }
      }
    },

    {
      connection: createBullMQConnection(null),
      concurrency: 5
    }
  );

distributedLockWorker.on("failed", (job, error) => {
  console.error(
    `[distributed-lock] Job failed jobId=${job?.id}`,
    error
  );
});

distributedLockWorker.on("error", (error) => {
  console.error(
    "[distributed-lock] Worker error",
    error
  );
});
```

### Understand the critical code

#### A. Acquire before entering the critical section

```ts
const token = await distributedLockService.acquire(
  resource,
  LOCK_TTL_MS
);

if (!token) {
  throw new Error(`Resource is locked: ${resource}`);
}
```

If Redis reports that another owner holds the lock, this worker does not enter the protected section.

The error lets BullMQ apply its retry policy.

#### B. Release in `finally`

```ts
finally {
  const released =
    await distributedLockService.release(resource, token);
}
```

The worker attempts to release the lock whether the simulated work succeeds or throws.

The release method checks ownership using the token. A worker must never blindly delete a lock belonging to another owner.

#### C. Handle release failure deliberately

The code logs release failures rather than silently ignoring them. The lock may remain until its TTL expires.

For a real business operation, release failure should also trigger appropriate monitoring or alerting.

#### D. Why use `concurrency: 5`?

This allows one worker process to process up to five jobs concurrently. Jobs that contend for the same report resource will compete for the same Redis lock.

Jobs for different resources can proceed concurrently.

The concurrency setting does not create a distributed lock by itself.

---

## 8. Create the API Route

**File:** `src/routes/distributed-lock.routes.ts`

**Action:** Create this file.

```ts
import { Router } from "express";

import { enqueueDistributedLockJob } from "../queues/producers/distributed-lock.producer.js";

export const distributedLockRoutes = Router();

distributedLockRoutes.post("/worker", async (req, res) => {
  const body: unknown = req.body;

  if (
    typeof body !== "object" ||
    body === null ||
    !("reportId" in body) ||
    !("workMs" in body)
  ) {
    res.status(400).json({
      success: false,
      message: "reportId and workMs are required"
    });

    return;
  }

  const { reportId, workMs } = body;

  if (
    typeof reportId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(reportId)
  ) {
    res.status(400).json({
      success: false,
      message: "reportId must contain 1-100 letters, numbers, underscores, or hyphens"
    });

    return;
  }

  if (
    typeof workMs !== "number" ||
    !Number.isInteger(workMs) ||
    workMs < 100 ||
    workMs > 25_000
  ) {
    res.status(400).json({
      success: false,
      message: "workMs must be an integer between 100 and 25000"
    });

    return;
  }

  try {
    const jobId = await enqueueDistributedLockJob({
      reportId,
      workMs
    });

    res.status(202).json({
      success: true,
      message: "Distributed-lock demonstration job queued",
      jobId,
      reportId,
      workMs
    });
  } catch (error) {
    console.error(
      "[distributed-lock] Failed to enqueue job",
      error
    );

    res.status(503).json({
      success: false,
      message: "Unable to enqueue the job"
    });
  }
});
```

The endpoint validates its input and returns `202 Accepted` because the job is queued for background processing.

It does not claim that the report has already been processed.

---

## 9. Register the Route

**File:** `src/app.ts`

**Action:** Modify the existing file. Do not replace the whole file.

Add this import beside your other route imports:

```ts
import { distributedLockRoutes } from "./routes/distributed-lock.routes.js";
```

Register the route beside your other `app.use(...)` calls:

```ts
app.use("/demo/locks", distributedLockRoutes);
```

The new endpoint is:

```text
POST /demo/locks/worker
```

Keep your existing security middleware, request ID middleware, JSON parser, error middleware, and not-found middleware in their existing order.

The JSON parser must be registered before this route.

---

## 10. Register the Worker Lifecycle

**File:** `src/workers.ts`

**Action:** Modify the existing worker lifecycle. Do not replace your existing `start()` or shutdown implementation.

### 10.1 Add the import

```ts
import { distributedLockWorker } from "./workers/distributed-lock.worker.js";

import { distributedLockQueue } from "./queues/distributed-lock.queue.js";
```

### 10.2 Add readiness during startup

Inside your existing `start()` function, add the following alongside the other worker readiness checks:

```ts
await distributedLockQueue.waitUntilReady();
await distributedLockWorker.waitUntilReady();
```

Preserve your existing readiness checks for demo, external API, fan-out, pipeline, parent-child, workload, sharded, and idempotency workers.

### 10.3 Add startup-failure cleanup

Inside your existing startup `catch` block, include these resources in the existing `Promise.allSettled(...)` cleanup list:

```ts
distributedLockWorker.close(),
distributedLockQueue.close()
```

Do not create a second cleanup block if your existing code already has one.

### 10.4 Add graceful shutdown cleanup

Include the following resources in your existing shutdown process:

```ts
await distributedLockWorker.close();
await distributedLockQueue.close();
```

Place them consistently with your current worker and queue shutdown sequence.

If your lifecycle currently closes workers concurrently with `Promise.all(...)`, add the worker to that existing group. Add the queue to the existing queue cleanup sequence.

**Important:** Each resource should be closed only once per shutdown path. Preserve your existing `isShuttingDown` guard and error handling.

---

## 11. Build and Test

Open PowerShell at the project root.

### Step 1: Run the unit tests from Lecture 2

```powershell
npm run test:run -- tests/distributed-lock.service.test.ts
```

Expected: the distributed lock service tests pass.

### Step 2: Build TypeScript

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

If compilation fails, fix the reported import, type, or lifecycle issue before proceeding. Do not skip a build error.

### Step 3: Start the API

Terminal 1:

```powershell
npm run dev
```

Expected: the API starts on the configured port, normally `3000`.

### Step 4: Start the workers

Terminal 2:

```powershell
npm run dev:worker
```

Expected: the worker process starts and the distributed-lock worker becomes ready.

Keep both processes running for the next exercise.

---

## 12. Test Concurrent Requests

We will submit two jobs for the same report.

### Step 1: Submit the first job

PowerShell:

```powershell
$body1 = @{
    reportId = "report-1001"
    workMs = 5000
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/locks/worker" `
    -ContentType "application/json" `
    -Body $body1
```

Expected: a response containing `success: true`, a job ID, and `report-1001`.

### Step 2: Submit the second job immediately

```powershell
$body2 = @{
    reportId = "report-1001"
    workMs = 1000
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/locks/worker" `
    -ContentType "application/json" `
    -Body $body2
```

Expected: another successful enqueue response with a different job ID.

Both HTTP requests should return quickly because they enqueue background work.

### Step 3: Inspect worker logs

Watch Terminal 2.

You should observe logs similar to:

```text
[distributed-lock] Acquired resource=report:report-1001 jobId=1
[distributed-lock] Work started resource=report:report-1001 jobId=1
[distributed-lock] Work finished resource=report:report-1001 jobId=1
[distributed-lock] Released resource=report:report-1001 jobId=1
```

The second job may initially fail to acquire the lock and be retried. Once the first job releases the lock, the second job can acquire it.

Job IDs, timing, and log ordering depend on the state of your queue and worker.

### Step 4: Check the lock key

While a job is running, open another PowerShell terminal:

```powershell
docker compose exec redis redis-cli GET lock:report:report-1001
```

If the worker currently holds the lock, the command should return its token.

If the job has already finished and released the lock, Redis will return `(nil)`.

Do not expect the lock to remain present after successful processing.

---

## 13. Break It Intentionally

### Experiment A: Submit invalid work duration

```powershell
$body = @{
    reportId = "report-1001"
    workMs = 999999
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/locks/worker" `
    -ContentType "application/json" `
    -Body $body
```

Expected: HTTP 400 because the duration exceeds the permitted range.

**Root cause:** The route deliberately validates input before creating a job.

**Fix:** Use a valid duration between 100 and 25,000 milliseconds.

### Experiment B: Make the lock unavailable

While a job is processing `report-1001`, use Redis CLI to inspect its key:

```powershell
docker compose exec redis redis-cli GET lock:report:report-1001
```

Submit another job for the same report while the first is still working.

Expected: the second worker attempt may fail with `Resource is locked`, then BullMQ retries according to its backoff policy.

**Root cause:** Another job owns the shared lock.

**Fix:** Let the first job finish and release its lock. The retry can then attempt acquisition again.

### Experiment C: Remove safe release

In a temporary copy of the worker, remove the `finally` release logic and run the experiment. Do not leave this change in your working implementation.

After the work completes, inspect the lock key.

Expected: the key may remain until its TTL expires.

**Root cause:** Successful business processing does not automatically delete a Redis key.

**Fix:** Restore token-checked release in `finally`. The TTL remains a recovery mechanism for crashes, not a substitute for correct cleanup.

---

## 14. Production Considerations

### A. A lock can expire while work is still running

Our demonstration uses a 30-second TTL and allows work to last at most 25 seconds. This gives the demonstration some margin, but it does not protect against arbitrary pauses, CPU stalls, or network delays.

If the lease expires, another worker can acquire the lock while the original worker is still executing.

For long-running tasks, consider safe lease renewal and fencing tokens. We will cover these in a later lecture.

### B. Lock release can fail

The worker logs a release failure and allows the TTL to provide eventual cleanup.

For production business operations, add metrics and alerts for release failures and lease expiration. Also design recovery behavior so an expired lock cannot silently corrupt shared state.

### C. Retries are not exactly-once execution

BullMQ can deliver a job more than once. A distributed lock prevents overlapping ownership only while the lease remains valid.

Use idempotency keys, database constraints, and transactions where necessary to prevent duplicate business effects.

### D. Do not lock the entire application unnecessarily

Use a lock around the smallest shared critical section that needs coordination.

Unrelated resources should not contend for the same lock key.

### E. Consider whether PostgreSQL is the better lock manager

For an operation that changes a particular database row, PostgreSQL transactions and row-level locks may provide stronger and more natural protection than a separate Redis lock.

Choose the mechanism based on the resource and correctness requirement.

---

## 15. Final Checklist

- [ ] Created the job type.
- [ ] Created the queue and producer.
- [ ] Created the distributed-lock worker.
- [ ] Registered the route.
- [ ] Integrated worker readiness and shutdown without replacing existing lifecycle code.
- [ ] Ran the Lecture 2 lock service tests.
- [ ] Built the TypeScript application.
- [ ] Started the API and worker processes.
- [ ] Submitted two jobs for the same report.
- [ ] Observed contention and retry behavior.
- [ ] Verified lock release and TTL recovery.
- [ ] Understood why locks do not guarantee exactly-once execution.

## Success Criteria

Lecture 3 is complete when the project builds, the worker starts, two jobs for the same resource coordinate through Redis, and the lock is safely released after processing.

**Next: Module 3 — Lecture 4: The Redlock Algorithm.** We will examine what changes when Redis availability and failover enter the picture, and why a distributed lock's safety guarantees must be understood before relying on it in production.
