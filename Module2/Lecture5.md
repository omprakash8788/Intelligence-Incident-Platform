# Module 2 — Lecture 5

# BullMQ Producer & Worker Lifecycle

> **Project:** Production Intelligence & Incident Platform
> **Module:** Module 2 — Redis & Background Jobs
> **Lecture:** 5
> **Stack:** Node.js + TypeScript + Express + PostgreSQL + Redis + BullMQ
> **Method:** Build → Test → Break → Fix → Verify
> **AI:** Not used

---

# Table of Contents

1. [Lecture Objective](#1-lecture-objective)
2. [What We Built in Lecture 4](#2-what-we-built-in-lecture-4)
3. [What We Learn Today](#3-what-we-learn-today)
4. [The BullMQ Job Lifecycle](#4-the-bullmq-job-lifecycle)
5. [Waiting State](#5-waiting-state)
6. [Active State](#6-active-state)
7. [Completed State](#7-completed-state)
8. [Failed State](#8-failed-state)
9. [Improve the Demo Job](#9-improve-the-demo-job)
10. [Create a Job Inspection Service](#10-create-a-job-inspection-service)
11. [Create a Job Status Endpoint](#11-create-a-job-status-endpoint)
12. [Test Waiting State](#12-test-waiting-state)
13. [Test Active State](#13-test-active-state)
14. [Test Completed State](#14-test-completed-state)
15. [Intentional Failure](#15-intentional-failure)
16. [Inspect Failed Jobs](#16-inspect-failed-jobs)
17. [Understand Producer Failure](#17-understand-producer-failure)
18. [Understand Worker Failure](#18-understand-worker-failure)
19. [Break Test — Kill Worker](#19-break-test--kill-worker)
20. [Fix and Recovery](#20-fix-and-recovery)
21. [Run Full Test Suite](#21-run-full-test-suite)
22. [Final Architecture](#22-final-architecture)
23. [Final Folder Structure](#23-final-folder-structure)
24. [Success Criteria](#24-success-criteria)
25. [What We Deliberately Do Not Implement](#25-what-we-deliberately-do-not-implement)
26. [Next Lecture](#26-next-lecture)

---

# 1. Lecture Objective

In Lecture 4, we created:

```
Producer
   ↓
Queue
   ↓
Redis
   ↓
Worker
   ↓
Processor
```

Today we will understand **what happens to a single job during its entire lifecycle**.

The lifecycle we care about is:

```
                ┌───────────┐
                │  WAITING  │
                └─────┬─────┘
                      │
                      ▼
                ┌───────────┐
                │   ACTIVE  │
                └─────┬─────┘
                      │
             ┌────────┴────────┐
             │                 │
             ▼                 ▼
       ┌───────────┐     ┌──────────┐
       │ COMPLETED │     │  FAILED  │
       └───────────┘     └──────────┘
```

We will learn how to:

- create jobs
- inspect jobs
- identify job state
- observe waiting jobs
- observe active jobs
- observe completed jobs
- intentionally fail jobs
- inspect failed jobs
- understand producer failures
- understand worker failures
- understand what happens when a worker disappears

We will **not implement retries yet**.

---

# 2. What We Built in Lecture 4

Our current queue is:

```
src/queues/demo.queue.ts
```

```
import {
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

export const DEMO_QUEUE_NAME =
  "demo-job";

export const demoQueue =
  new Queue(
    DEMO_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(
          1
        )
    }
  );
```

Our job data:

```
src/queues/jobs/demo.job.ts
```

```
export interface DemoJobData {
  message: string;
}
```

Our producer:

```
src/queues/producers/demo.producer.ts
```

```
import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData
} from "../jobs/demo.job.js";

export const addDemoJob =
  async (
    data: DemoJobData
  ): Promise<string> => {

    const job =
      await demoQueue.add(
        "demo-job",
        data
      );

    if (
      job.id === undefined
    ) {
      throw new Error(
        "BullMQ job ID was not generated"
      );
    }

    return job.id;
  };
```

And our worker:

```
src/workers/demo.worker.ts
```

The important concept is:

```
Producer
    ≠
Worker
```

The producer creates the job.

The worker processes the job.

---

# 3. What We Learn Today

Imagine the following request:

```
POST /demo/jobs
```

The API receives it.

Then:

```
API
 │
 ▼
Producer
 │
 ▼
Queue
 │
 ▼
Redis
```

At this point, the job hasn't been processed yet.

It is waiting.

Then a worker picks it up:

```
WAITING
   ↓
ACTIVE
```

The processor executes.

If successful:

```
ACTIVE
   ↓
COMPLETED
```

If the processor throws:

```
ACTIVE
   ↓
FAILED
```

This distinction is fundamental.

---

# 4. The BullMQ Job Lifecycle

A simplified lifecycle is:

```
              queue.add()
                   │
                   ▼
             ┌──────────┐
             │ WAITING  │
             └────┬─────┘
                  │
                  │ Worker picks job
                  ▼
             ┌──────────┐
             │  ACTIVE  │
             └────┬─────┘
                  │
           processor executes
                  │
             ┌────┴─────┐
             │          │
          success      error
             │          │
             ▼          ▼
       ┌───────────┐ ┌────────┐
       │ COMPLETED │ │ FAILED │
       └───────────┘ └────────┘
```

BullMQ manages these job states for us. The worker is responsible for taking waiting jobs and executing the processor; successful processing moves the job to completed, while thrown errors result in failed jobs.

---

# 5. Waiting State

When the producer executes:

```
await demoQueue.add(
  "demo-job",
  data
);
```

the job enters the queue.

Conceptually:

```
Producer
   │
   ▼
queue.add()
   │
   ▼
WAITING
```

If there is no worker:

```
WAITING
   │
   │
   │  worker unavailable
   │
   ▼
WAITING
```

The job remains available for a worker.

This is the first important property of a background-job system:

> **Job creation and job processing are decoupled.**

---

# 6. Active State

When a worker takes the job:

```
WAITING
   │
   ▼
ACTIVE
```

Now the worker's processor executes.

For example:

```
async (
  job
) => {

  console.log(
    "Processing..."
  );

  return {
    processed: true
  };
}
```

During this period, the job is active.

---

# 7. Completed State

If the processor returns normally:

```
return {
  processed: true
};
```

BullMQ considers the job successfully processed.

The lifecycle becomes:

```
WAITING
   ↓
ACTIVE
   ↓
COMPLETED
```

The returned value becomes the job's result.

This gives us a useful distinction:

```
Job data
    ↓
Input

Job return value
    ↓
Result
```

For example:

```
Input:

{
  message: "hello"
}

Result:

{
  processed: true
}
```

---

# 8. Failed State

Now consider:

```
throw new Error(
  "Something went wrong"
);
```

The lifecycle becomes:

```
WAITING
   ↓
ACTIVE
   ↓
FAILED
```

This is different from the API throwing an error.

The HTTP request has already finished.

For example:

```
POST /demo/jobs
      │
      ▼
Job created
      │
      ▼
HTTP 202
      │
      X
HTTP request finished

Later...

Worker
   │
   ▼
Job fails
```

This is why background-job error handling is different from normal HTTP error handling.

---

# 9. Improve the Demo Job

Our current job only contains:

```
interface DemoJobData {
  message: string;
}
```

For lifecycle testing, we need to tell the worker whether we want:

- normal processing
- slow processing
- intentional failure

We will add a controlled test mode.

## 9.1 Modify Job Type

### File

```
src/queues/jobs/demo.job.ts
```

Replace the complete file with:

```
export type DemoJobMode =
  | "success"
  | "slow"
  | "failure";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}
```

Now our job can look like:

```
{
  "message": "Hello BullMQ",
  "mode": "success"
}
```

or:

```
{
  "message": "Testing failure",
  "mode": "failure"
}
```

---

# 10. Update Producer

### File

```
src/queues/producers/demo.producer.ts
```

Replace the complete file:

```
import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData
} from "../jobs/demo.job.js";

export const addDemoJob =
  async (
    data: DemoJobData
  ): Promise<string> => {

    const job =
      await demoQueue.add(
        "demo-job",
        data
      );

    if (
      job.id === undefined
    ) {
      throw new Error(
        "BullMQ job ID was not generated"
      );
    }

    return job.id;
  };
```

No structural change is needed here.

The producer already accepts the typed job data.

---

# 11. Update Worker

### File

```
src/workers/demo.worker.ts
```

Replace the complete file with:

```
import {
  Worker,
  Job
} from "bullmq";

import {
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import type {
  DemoJobData
} from "../queues/jobs/demo.job.js";

export const demoWorker =
  new Worker<
    DemoJobData,
    {
      processed: boolean;
    }
  >(
    DEMO_QUEUE_NAME,

    async (
      job: Job<DemoJobData>
    ) => {

      console.log(
        `[DemoWorker] Processing job ${job.id}`
      );

      console.log(
        `[DemoWorker] Mode: ${job.data.mode}`
      );

      console.log(
        `[DemoWorker] Message: ${job.data.message}`
      );

      if (
        job.data.mode ===
        "failure"
      ) {
        throw new Error(
          "Intentional demo job failure"
        );
      }

      if (
        job.data.mode ===
        "slow"
      ) {
        await new Promise<void>(
          (resolve) => {
            setTimeout(
              resolve,
              10000
            );
          }
        );
      }

      return {
        processed: true
      };
    },

    {
      connection:
        createBullMQConnection(
          null
        )
    }
  );

demoWorker.on(
  "completed",
  (job) => {

    console.log(
      `[DemoWorker] Job ${job.id} completed`
    );
  }
);

demoWorker.on(
  "failed",
  (
    job,
    error
  ) => {

    console.error(
      `[DemoWorker] Job ${job?.id ?? "unknown"} failed`,
      error
    );
  }
);

demoWorker.on(
  "error",
  (error) => {

    console.error(
      "[DemoWorker] Worker error",
      error
    );
  }
);
```

---

# 12. Why We Added `slow`

We need a way to observe the `active` state.

If processing takes only 1 millisecond:

```
WAITING
  ↓
ACTIVE
  ↓
COMPLETED
```

happens so quickly that we cannot easily inspect it.

With:

```
setTimeout(
  resolve,
  10000
);
```

the job remains active for approximately 10 seconds.

That gives us a window to inspect it.

---

# 13. Update Demo Route

We currently hardcoded the message.

Now we'll accept:

```
{
  "message": "...",
  "mode": "success"
}
```

### File

```
src/routes/demo-queue.routes.ts
```

Replace the complete file:

```
import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

import type {
  DemoJobMode
} from "../queues/jobs/demo.job.js";

const router =
  Router();

router.post(
  "/demo/jobs",
  async (
    req,
    res,
    next
  ) => {

    try {

      const {
        message,
        mode
      } = req.body as {
        message?: unknown;
        mode?: unknown;
      };

      if (
        typeof message !==
        "string"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MESSAGE",
            message:
              "message must be a string"
          }
        });

        return;
      }

      if (
        mode !== "success" &&
        mode !== "slow" &&
        mode !== "failure"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MODE",
            message:
              "mode must be success, slow, or failure"
          }
        });

        return;
      }

      const jobId =
        await addDemoJob({
          message,
          mode:
            mode as DemoJobMode
        });

      res.status(202).json({
        success: true,
        data: {
          jobId
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

> This is a learning endpoint. We are deliberately keeping validation local and simple. Later, we'll apply the project's established validation architecture rather than keeping ad-hoc validation inside routes.

---

# 14. Build

Run:

```
npm run build
```

### Expected

No TypeScript errors.

If you get an error:

> **Stop here and fix it before continuing.**

---

# 15. Create Job Inspection Service

Now we want to inspect individual jobs.

### Create:

```
src/services/demo-job.service.ts
```

### Complete file

```
import type {
  Job,
  JobState
} from "bullmq";

import {
  demoQueue
} from "../queues/demo.queue.js";

export interface DemoJobStatus {
  id: string;
  name: string;
  state: JobState;
  data: unknown;
  result: unknown;
  failedReason: string | undefined;
}

export const getDemoJobStatus =
  async (
    jobId: string
  ): Promise<
    DemoJobStatus | null
  > => {

    const job =
      await demoQueue.getJob(
        jobId
      );

    if (!job) {
      return null;
    }

    const state =
      await job.getState();

    return {
      id:
        job.id ?? jobId,

      name:
        job.name,

      state,

      data:
        job.data,

      result:
        job.returnvalue,

      failedReason:
        job.failedReason
    };
  };
```

---

# 16. Why `job.getState()`?

The job object contains information about the job, but the current lifecycle state should be obtained from BullMQ.

We therefore ask:

```
await job.getState();
```

Possible states include concepts such as:

```
waiting
active
completed
failed
```

This allows us to observe the lifecycle rather than guessing based on timestamps or application logs.

---

# 17. Add Job Status Endpoint

### File

```
src/routes/demo-queue.routes.ts
```

Add this route **before** the final:

```
export default router;
```

```
router.get(
  "/demo/jobs/:jobId",
  async (
    req,
    res,
    next
  ) => {

    try {

      const job =
        await getDemoJobStatus(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "JOB_NOT_FOUND",
            message:
              "Demo job not found"
          }
        });

        return;
      }

      res.status(200).json({
        success: true,
        data: job
      });

    } catch (error) {
      next(error);
    }
  }
);
```

But we need the import.

At the top of the same file, add:

```
import {
  getDemoJobStatus
} from "../services/demo-job.service.js";
```

---

# 18. Complete Route File

To avoid mixing sections, your complete file should now be:

### `src/routes/demo-queue.routes.ts`

```
import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

import {
  getDemoJobStatus
} from "../services/demo-job.service.js";

import type {
  DemoJobMode
} from "../queues/jobs/demo.job.js";

const router =
  Router();

router.post(
  "/demo/jobs",
  async (
    req,
    res,
    next
  ) => {

    try {

      const {
        message,
        mode
      } = req.body as {
        message?: unknown;
        mode?: unknown;
      };

      if (
        typeof message !==
        "string"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MESSAGE",
            message:
              "message must be a string"
          }
        });

        return;
      }

      if (
        mode !== "success" &&
        mode !== "slow" &&
        mode !== "failure"
      ) {
        res.status(400).json({
          success: false,
          error: {
            code:
              "INVALID_MODE",
            message:
              "mode must be success, slow, or failure"
          }
        });

        return;
      }

      const jobId =
        await addDemoJob({
          message,
          mode:
            mode as DemoJobMode
        });

      res.status(202).json({
        success: true,
        data: {
          jobId
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/demo/jobs/:jobId",
  async (
    req,
    res,
    next
  ) => {

    try {

      const job =
        await getDemoJobStatus(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code:
              "JOB_NOT_FOUND",
            message:
              "Demo job not found"
          }
        });

        return;
      }

      res.status(200).json({
        success: true,
        data: job
      });

    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

---

# 19. Build Again

```
npm run build
```

This must pass.

---

# 20. Start the Infrastructure

Start PostgreSQL and Redis:

```
docker compose up -d postgres redis
```

Verify:

```
docker compose ps
```

Both should be healthy.

Redis:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

---

# 21. Start the API

Because our API is Dockerized:

```
docker compose build api
```

Then:

```
docker compose up -d --force-recreate api
```

Verify:

```
docker compose ps
```

API should be healthy.

---

# 22. Start Worker

Open another PowerShell terminal:

```
npm run dev:worker
```

Expected:

```
Worker process started
```

---

# 23. Lifecycle Test — SUCCESS

Create a normal job.

### PowerShell

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Lifecycle success test","mode":"success"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

Expected:

```
{
  "success": true,
  "data": {
    "jobId": "..."
  }
}
```

Copy the job ID.

For example:

```
1
```

---

# 24. Inspect Completed Job

Run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/1
```

Use your actual ID.

Expected structure:

```
{
  "success": true,
  "data": {
    "id": "1",
    "name": "demo-job",
    "state": "completed",
    "data": {
      "message": "Lifecycle success test",
      "mode": "success"
    },
    "result": {
      "processed": true
    }
  }
}
```

The exact job ID will differ.

---

# 25. Lifecycle Test — WAITING

Now stop the worker.

In the worker terminal:

```
Ctrl + C
```

Create a job:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Waiting state test","mode":"success"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

Copy the job ID.

Immediately inspect it:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/<JOB_ID>
```

Expected:

```
{
  "success": true,
  "data": {
    "state": "waiting"
  }
}
```

Depending on exact timing, if another worker is running, it could transition immediately. Make sure **no worker is running** during this test.

---

# 26. Start Worker

```
npm run dev:worker
```

The waiting job should now be processed.

Then:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/<JOB_ID>
```

Expected:

```
{
  "success": true,
  "data": {
    "state": "completed"
  }
}
```

We have proven:

```
WAITING
   ↓
Worker starts
   ↓
ACTIVE
   ↓
COMPLETED
```

---

# 27. Lifecycle Test — ACTIVE

Create a slow job:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Active state test","mode":"slow"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

Copy the job ID.

Immediately run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/<JOB_ID>
```

Expected:

```
{
  "success": true,
  "data": {
    "state": "active"
  }
}
```

Because the worker intentionally waits for approximately 10 seconds.

After 10 seconds:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/<JOB_ID>
```

Expected:

```
{
  "success": true,
  "data": {
    "state": "completed"
  }
}
```

You have now directly observed:

```
WAITING
   ↓
ACTIVE
   ↓
COMPLETED
```

---

# 28. Lifecycle Test — FAILED

Now intentionally create a failure.

Run:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Intentional failure test","mode":"failure"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

The producer should still return:

```
202
```

This is extremely important.

The API successfully created the job.

The **background processing** is what failed.

---

# 29. Inspect the Failed Job

Run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/<JOB_ID>
```

Expected:

```
{
  "success": true,
  "data": {
    "state": "failed",
    "failedReason": "Intentional demo job failure"
  }
}
```

Your worker terminal should also show:

```
[DemoWorker] Job <id> failed
```

This proves:

```
Producer success
      ↓
HTTP 202
      ↓
Worker starts
      ↓
Processor throws
      ↓
Job FAILED
```

---

# 30. Critical Concept — HTTP Success ≠ Job Success

This is one of the most important lessons of this lecture.

Consider:

```
POST /demo/jobs
```

returns:

```
202 Accepted
```

That means:

> The system accepted the job.

It does **not** mean:

> The background operation succeeded.

The actual lifecycle is:

```
HTTP
 │
 ├── 202 Accepted
 │
 ▼
Queue
 │
 ▼
Worker
 │
 ├── success → COMPLETED
 │
 └── error   → FAILED
```

This distinction becomes critical in real systems.

---

# 31. Producer Failure vs Worker Failure

These are two completely different failures.

## Producer failure

```
HTTP Request
     ↓
Producer
     ↓
Redis unavailable
     ↓
Job cannot be created
```

The API should report an error because the job was never accepted.

---

## Worker failure

```
HTTP Request
     ↓
Producer
     ↓
Redis
     ↓
202 Accepted
     ↓
Worker
     ↓
Processing error
     ↓
FAILED
```

The API request has already succeeded.

This is why we need job status, retries, observability, and later alerting.

---

# 32. BREAK TEST — Kill Worker During Active Processing

Now we intentionally break the system.

Create a slow job:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Worker crash test","mode":"slow"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

Immediately watch the worker:

```
[DemoWorker] Processing job ...
```

Then press:

```
Ctrl + C
```

before the 10 seconds finish.

We have intentionally killed the worker during processing.

---

# 33. What Should You Understand Here?

Do **not** assume:

```
Worker crashed
    ↓
Job disappeared
```

That would defeat the purpose of a durable queue.

Instead, BullMQ has mechanisms for tracking active jobs and detecting stalled processing. Worker failure and stalled-job recovery are separate concepts from ordinary processor exceptions.

We are deliberately **not configuring retries or advanced stalled-job settings yet**.

The purpose of this test is to understand that:

> **A worker process is disposable; the queue is the durable coordination mechanism.**

---

# 34. Restart Worker

Run:

```
npm run dev:worker
```

Watch the worker.

Depending on timing and BullMQ's stalled-job detection, the interrupted job may not become available immediately. Do not assume instantaneous recovery.

This is an important distributed-systems lesson:

```
Worker disappearance
        ≠
instantaneous knowledge
```

There can be a detection interval.

Later we will study this carefully.

---

# 35. Why We Don't Add Retries Yet

You might now ask:

> If the job fails, why don't we just retry it?

Because we haven't yet established the fundamental lifecycle.

First:

```
WAITING
ACTIVE
COMPLETED
FAILED
```

Then:

```
FAILED
   ↓
retry
   ↓
WAITING
   ↓
ACTIVE
```

Then:

```
retry
retry
retry
```

Then:

```
backoff
```

Then:

```
dead-letter handling
```

Then:

```
idempotency
```

We will introduce these in separate lectures.

---

# 36. Clean Up Test Jobs

For this learning queue, it is useful to inspect jobs.

You can remove individual jobs through BullMQ, but we don't want to introduce queue administration APIs yet.

For now, the queue is disposable.

If you want to reset the development Redis database **only if you are certain this Redis instance contains no important project data**, you can use:

```
docker compose exec redis redis-cli FLUSHDB
```

### Warning

Do **not** run `FLUSHDB` against a shared production Redis database.

For this local development environment, it is acceptable only if the Redis database is dedicated to this project.

---

# 37. Test Invalid Input

Our demo route should reject invalid modes.

Run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Invalid mode","mode":"unknown"}' `
  http://localhost:3000/demo/jobs
```

Expected HTTP status:

```
400
```

Expected error:

```
{
  "success": false,
  "error": {
    "code": "INVALID_MODE",
    "message": "mode must be success, slow, or failure"
  }
}
```

---

# 38. Test Missing Message

Run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"mode":"success"}' `
  http://localhost:3000/demo/jobs
```

Expected:

```
400
```

---

# 39. Build Again

Run:

```
npm run build
```

Must pass.

---

# 40. Run Existing Tests

Run:

```
npm run test:run
```

All existing tests should remain green.

We haven't yet created automated integration tests for the real BullMQ worker lifecycle.

That is intentional.

Real Redis/BullMQ integration tests require careful process and queue cleanup, and we will build those once the queue architecture stabilizes.

---

# 41. Important Production Observation

Our current architecture is:

```
API
 │
 ├── PostgreSQL
 │
 └── Redis
       │
       └── BullMQ Queue
              │
              └── Worker
```

But the worker currently runs outside Docker:

```
Windows host
    │
    └── npm run dev:worker
```

This is acceptable for development.

Later we will add a dedicated Docker worker:

```
docker-compose
   │
   ├── postgres
   ├── redis
   ├── api
   └── worker
```

But **do not implement that yet**.

We want to understand the lifecycle first.

---

# 42. Current Queue Connection Architecture

We now have:

```
Application Redis
        │
        ▼
src/redis/client.ts
```

and separately:

```
BullMQ
   │
   ├── Queue connection
   │
   └── Worker connection
```

This is intentional.

```
Application Redis
        ≠
BullMQ Worker Redis
```

They may point to the same Redis server, but their connection responsibilities differ.

---

# 43. Final Architecture

At the end of Lecture 5:

```
                           ┌──────────────┐
                           │    Client    │
                           └──────┬───────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │   Express API   │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │     Producer    │
                         └────────┬────────┘
                                  │
                              queue.add()
                                  │
                                  ▼
                         ┌─────────────────┐
                         │     BullMQ      │
                         │      Queue      │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │      Redis      │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │     Worker      │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │    Processor    │
                         └────────┬────────┘
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                   ┌───────────┐     ┌──────────┐
                   │ COMPLETED │     │  FAILED  │
                   └───────────┘     └──────────┘
```

---

# 44. Final Folder Structure

```
src/
├── config/
│   ├── config.types.ts
│   ├── env.ts
│   └── rate-limit.ts
│
├── controllers/
│
├── database/
│
├── domain/
│
├── errors/
│
├── logging/
│
├── middleware/
│
├── redis/
│   ├── client.ts
│   ├── health.ts
│   └── lifecycle.ts
│
├── repositories/
│
├── routes/
│   ├── health.routes.ts
│   ├── incident.routes.ts
│   └── demo-queue.routes.ts
│
├── queues/
│   ├── bullmq.connection.ts
│   ├── demo.inspect.ts
│   ├── demo.queue.ts
│   ├── jobs/
│   │   └── demo.job.ts
│   └── producers/
│       └── demo.producer.ts
│
├── services/
│   ├── demo-job.service.ts
│   ├── incident.service.ts
│   └── redis.service.ts
│
├── server/
│
├── types/
│
├── utils/
│
├── validators/
│
├── workers/
│   └── demo.worker.ts
│
├── app.ts
├── container.ts
├── server.ts
└── workers.ts
```

---

# 45. Lecture 5 Success Criteria

Do not consider Lecture 5 complete until you can verify all of these:

### Build

- `npm run build` passes

### Queue

- Producer creates job
- Job receives an ID
- Job enters waiting state

### Worker

- Worker starts independently
- Worker consumes jobs
- Worker processes job

### Lifecycle

- `waiting` observed
- `active` observed
- `completed` observed
- `failed` observed

### Failure

- Intentional processor failure tested
- Failed reason inspected
- Worker crash tested

### Recovery

- Worker restarted
- Queue remains available
- Existing jobs can be processed

### API

- `POST /demo/jobs`
- `GET /demo/jobs/:jobId`
- invalid mode returns 400
- missing message returns 400

### Existing project

- `npm run test:run` passes
- Redis remains healthy
- PostgreSQL remains healthy
- `/health/live` remains healthy
- `/health/ready` remains healthy when Redis is up

---

# 46. What We Have Learned

The most important concept from this lecture is:

```
             JOB LIFECYCLE

Producer
   │
   ▼
WAITING
   │
   ▼
ACTIVE
   │
   ├───────────────┐
   ▼               ▼
COMPLETED        FAILED
```

And the second most important concept:

```
HTTP SUCCESS
      ≠
BACKGROUND JOB SUCCESS
```

A `202 Accepted` means:

> **The system accepted the work.**

It does not mean:

> **The work completed successfully.**

That distinction is the foundation for retries, idempotency, monitoring, alerting, and eventually distributed job processing.

---

# 47. What We Do NOT Implement Yet

Not in this lecture:

```
❌ retries
❌ exponential backoff
❌ fixed backoff
❌ delayed jobs
❌ priorities
❌ concurrency
❌ rate limiting
❌ dead-letter queues
❌ QueueEvents
❌ FlowProducer
❌ job dependencies
❌ job deduplication
❌ idempotency
❌ worker autoscaling
```

We build those **after the lifecycle is completely understood**.
