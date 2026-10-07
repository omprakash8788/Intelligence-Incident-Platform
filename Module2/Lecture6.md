# Module 2 — Lecture 6

# BullMQ Job Failures, Retries & Exponential Backoff

> **Project:** Production Intelligence & Incident Platform
> **Module:** Module 2 — Redis & Background Jobs
> **Lecture:** 6
> **Stack:** Node.js + TypeScript + Express + PostgreSQL + Redis + BullMQ
> **Method:** Build → Test → Break → Fix → Verify
> **AI:** Not used

---

# Table of Contents

1. [Lecture Objective](#1-lecture-objective)
2. [What We Already Know](#2-what-we-already-know)
3. [Why Retries Exist](#3-why-retries-exist)
4. [Failure Without Retries](#4-failure-without-retries)
5. [BullMQ Automatic Retries](#5-bullmq-automatic-retries)
6. [Understanding attempts](#6-understanding-attempts)
7. [Fixed Backoff](#7-fixed-backoff)
8. [Exponential Backoff](#8-exponential-backoff)
9. [Why Exponential Backoff Matters](#9-why-exponential-backoff-matters)
10. [Configure Our Demo Queue](#10-configure-our-demo-queue)
11. [Update Job Data](#11-update-job-data)
12. [Update the Worker](#12-update-the-worker)
13. [Update Job Inspection](#13-update-job-inspection)
14. [Build](#14-build)
15. [Test Successful Job](#15-test-successful-job)
16. [Test Automatic Retry](#16-test-automatic-retry)
17. [Observe Attempts](#17-observe-attempts)
18. [Observe Backoff](#18-observe-backoff)
19. [Break Test](#19-break-test)
20. [Important Retry Rules](#20-important-retry-rules)
21. [Temporary vs Permanent Errors](#21-temporary-vs-permanent-errors)
22. [Why We Should Not Retry Everything](#22-why-we-should-not-retry-everything)
23. [Retry Timeline](#23-retry-timeline)
24. [Testing Redis Failure](#24-testing-redis-failure)
25. [Build and Test](#25-build-and-test)
26. [Final Architecture](#26-final-architecture)
27. [Final Folder Structure](#27-final-folder-structure)
28. [Success Criteria](#28-success-criteria)
29. [What We Deliberately Do Not Implement](#29-what-we-deliberately-do-not-implement)
30. [Next Lecture](#30-next-lecture)

---

# 1. Lecture Objective

In Lecture 5, we learned:

```
WAITING
   ↓
ACTIVE
   ↓
COMPLETED
```

and:

```
WAITING
   ↓
ACTIVE
   ↓
FAILED
```

Today we extend the failed path:

```
WAITING
   ↓
ACTIVE
   ↓
FAILED
   ↓
RETRY
   ↓
WAITING
   ↓
ACTIVE
```

The goal is to understand **automatic retry behavior**.

We will implement:

- `attempts`
- fixed backoff
- exponential backoff
- retry observation
- attempt counting
- failure after all attempts are exhausted

We will **not implement yet**:

- dead-letter queues
- custom backoff
- jitter
- retryable-error classification
- idempotency
- distributed retry coordination

Those come later.

---

# 2. What We Already Know

Our current architecture is:

```
                    ┌──────────────┐
                    │ Express API  │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Producer   │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │    Queue     │
                    └──────┬───────┘
                           │
                           ▼
                       Redis
                           │
                           ▼
                    ┌──────────────┐
                    │    Worker    │
                    └──────┬───────┘
                           │
                           ▼
                       Processor
```

Currently, if our processor throws:

```
throw new Error(
  "Something went wrong"
);
```

the job becomes:

```
FAILED
```

BullMQ supports automatic retries through the `attempts` option. If `attempts` is greater than 1, a failed job can be processed again. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

---

# 3. Why Retries Exist

Imagine our incident platform sends an incident notification to an external service.

The request fails:

```
Worker
  ↓
Notification API
  ↓
503 Service Unavailable
```

Does that necessarily mean the operation can never succeed?

No.

The external service might recover after two seconds.

Without retries:

```
Attempt 1
   ↓
503
   ↓
FAILED
```

With retries:

```
Attempt 1
   ↓
503
   ↓
wait
   ↓
Attempt 2
   ↓
503
   ↓
wait
   ↓
Attempt 3
   ↓
200
   ↓
COMPLETED
```

Retries are therefore useful for **transient failures**.

---

# 4. Failure Without Retries

Our current job behaves approximately like:

```
attempts = 1
```

So:

```
Attempt 1
    ↓
processor throws
    ↓
FAILED
```

There is no second attempt.

BullMQ's current job options define `attempts` as the total number of attempts to process a job. [BullMQ](https://docs.bullmq.io/api/interfaces/v3.BaseJobOptions.html?utm_source=chatgpt.com)

---

# 5. BullMQ Automatic Retries

We can configure:

```
attempts: 3
```

That means:

```
Maximum processing attempts = 3
```

Not:

```
3 retries + original attempt
```

Instead:

```
Attempt 1
Attempt 2
Attempt 3
```

If all three fail:

```
FAILED
```

Conceptually:

```
             attempt 1
                 ↓
              FAILED
                 ↓
             attempt 2
                 ↓
              FAILED
                 ↓
             attempt 3
                 ↓
              FAILED
```

If attempt 2 succeeds:

```
Attempt 1
   ↓
FAILED
   ↓
Attempt 2
   ↓
SUCCESS
   ↓
COMPLETED
```

---

# 6. Understanding `attempts`

The simplest configuration is:

```
attempts: 3
```

For example:

```
await queue.add(
  "email",
  data,
  {
    attempts: 3
  }
);
```

If the processor fails, BullMQ automatically retries according to the configured retry policy. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

But there is an important question:

> **When should the next attempt happen?**

That's where **backoff** comes in.

---

# 7. Fixed Backoff

A fixed backoff means:

> Wait the same amount of time before every retry.

For example:

```
backoff: {
  type: "fixed",
  delay: 2000
}
```

Timeline:

```
Attempt 1
   ↓
FAILED
   ↓
wait 2 sec
   ↓
Attempt 2
   ↓
FAILED
   ↓
wait 2 sec
   ↓
Attempt 3
```

BullMQ supports a built-in fixed backoff strategy. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

---

# 8. Exponential Backoff

Now imagine the dependency is under heavy load.

Retrying every two seconds may make things worse.

Instead:

```
Attempt 1
   ↓
FAIL
   ↓
1 sec
   ↓
Attempt 2
   ↓
FAIL
   ↓
2 sec
   ↓
Attempt 3
   ↓
FAIL
   ↓
4 sec
   ↓
Attempt 4
```

This is exponential backoff.

BullMQ's built-in exponential strategy uses:

```
2 ^ (attempts - 1) × delay
```

as the retry delay. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

For a `1000ms` base delay:

```
Retry 1 → 1 second
Retry 2 → 2 seconds
Retry 3 → 4 seconds
Retry 4 → 8 seconds
```

---

# 9. Why Exponential Backoff Matters

Imagine 10,000 jobs all fail because an external service is temporarily down.

Without backoff:

```
10,000 jobs
     ↓
all retry immediately
     ↓
external service
     ↓
OVERLOADED
```

Then:

```
failure
  ↓
retry
  ↓
failure
  ↓
retry
```

can create a **retry storm**.

With exponential backoff:

```
10,000 failed jobs

     ↓

retry over increasing intervals

     ↓

load is spread over time
```

This reduces pressure on dependencies.

---

# 10. Configure Our Demo Queue

We now want every demo job to have:

```
3 total attempts
+
exponential backoff
+
1 second base delay
```

### File

```
src/queues/demo.queue.ts
```

Replace the complete file:

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
        ),

      defaultJobOptions: {
        attempts: 3,

        backoff: {
          type: "exponential",
          delay: 1000
        }
      }
    }
  );
```

Now the queue has default retry behavior.

BullMQ allows `attempts` and `backoff` to be specified in `defaultJobOptions`, which applies those defaults to jobs added to the queue. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

---

# 11. Why Configure It at Queue Level?

We could put this on every job:

```
await demoQueue.add(
  "demo-job",
  data,
  {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000
    }
  }
);
```

But imagine we have 20 producers.

Then we'd duplicate the configuration everywhere.

Instead:

```
Queue
 │
 ├── attempts = 3
 └── exponential backoff = 1 sec
```

Every job gets the default policy.

Later, a particular job can override the defaults when needed.

---

# 12. Update Job Data

We already have:

### `src/queues/jobs/demo.job.ts`

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

We need one more mode so we can demonstrate:

> Fail twice, then succeed.

### Replace:

```
src/queues/jobs/demo.job.ts
```

with:

```
export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}
```

---

# 13. Update Worker

### File

```
src/workers/demo.worker.ts
```

Replace the complete file:

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
      attempt: number;
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
        `[DemoWorker] Attempt: ${job.attemptsMade + 1}`
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
          "Intentional permanent demo failure"
        );
      }

      if (
        job.data.mode ===
        "fail-twice"
      ) {

        if (
          job.attemptsMade < 2
        ) {
          throw new Error(
            `Intentional transient failure on attempt ${
              job.attemptsMade + 1
            }`
          );
        }
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
        processed: true,
        attempt:
          job.attemptsMade + 1
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
      {
        message:
          error.message,

        attemptsMade:
          job?.attemptsMade
      }
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

# 14. Understand `attemptsMade`

This line is important:

```
job.attemptsMade
```

BullMQ tracks how many attempts have already been made.

We use:

```
job.attemptsMade + 1
```

to display the attempt currently being executed.

For example:

```
attemptsMade = 0
```

means:

```
Current attempt = 1
```

Then:

```
attemptsMade = 1
```

means:

```
Current attempt = 2
```

BullMQ documents `attemptsMade` as the count of processing attempts made after normal processor errors. [BullMQ](https://docs.bullmq.io/patterns/stop-retrying-jobs?utm_source=chatgpt.com)

---

# 15. Understand `fail-twice`

This code:

```
if (
  job.data.mode ===
  "fail-twice"
) {

  if (
    job.attemptsMade < 2
  ) {
    throw new Error(...);
  }
}
```

creates this behavior:

```
Attempt 1
   ↓
FAIL

Attempt 2
   ↓
FAIL

Attempt 3
   ↓
SUCCESS
```

Because:

```
attemptsMade
```

starts at `0`.

---

# 16. Update Route Validation

### File

```
src/routes/demo-queue.routes.ts
```

Replace:

```
if (
  mode !== "success" &&
  mode !== "slow" &&
  mode !== "failure"
)
```

with:

```
if (
  mode !== "success" &&
  mode !== "slow" &&
  mode !== "failure" &&
  mode !== "fail-twice"
)
```

Also replace the error message:

```
message:
  "mode must be success, slow, failure, or fail-twice"
```

---

# 17. Update Job Inspection

We need to see:

- attempts made
- maximum attempts
- backoff configuration
- failed reason
- state

### File

```
src/services/demo-job.service.ts
```

Replace the complete file:

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
  attemptsMade: number;
  attemptsAllowed: number;
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

      attemptsMade:
        job.attemptsMade,

      attemptsAllowed:
        job.opts.attempts ?? 1,

      failedReason:
        job.failedReason
    };
  };
```

---

# 18. Build

Run:

```
npm run build
```

### Expected

No TypeScript errors.

If you get an error:

> Stop and fix it before continuing.

---

# 19. Test Successful Job

Make sure Redis is running:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

Start worker:

```
npm run dev:worker
```

Create successful job:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Retry lecture success test","mode":"success"}' `
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

Inspect it:

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
    "state": "completed",
    "attemptsMade": 1,
    "attemptsAllowed": 3
  }
}
```

---

# 20. Test Automatic Retry

Now create:

```
mode = fail-twice
```

Run:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Automatic retry test","mode":"fail-twice"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

Copy the job ID.

---

# 21. Watch Worker Logs

The worker should show something similar to:

```
[DemoWorker] Processing job 2
[DemoWorker] Attempt: 1
[DemoWorker] Mode: fail-twice
```

Then:

```
Intentional transient failure on attempt 1
```

The job should not immediately become permanently failed because:

```
attempts = 3
```

After the backoff:

```
[DemoWorker] Processing job 2
[DemoWorker] Attempt: 2
```

It fails again.

Then after another exponential delay:

```
[DemoWorker] Processing job 2
[DemoWorker] Attempt: 3
```

This time:

```
[DemoWorker] Job 2 completed
```

The complete lifecycle is:

```
WAITING
   ↓
ACTIVE
   ↓
FAILED
   ↓
backoff
   ↓
WAITING
   ↓
ACTIVE
   ↓
FAILED
   ↓
backoff
   ↓
WAITING
   ↓
ACTIVE
   ↓
COMPLETED
```

---

# 22. Observe Attempts

After completion:

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
    "state": "completed",
    "attemptsMade": 3,
    "attemptsAllowed": 3
  }
}
```

This is extremely important.

The job succeeded, but:

```
attemptsMade = 3
```

because it required three processing attempts.

---

# 23. Observe Exponential Backoff

Our configuration:

```
backoff: {
  type: "exponential",
  delay: 1000
}
```

means approximately:

```
Attempt 1
   ↓
failure
   ↓
~1 second
   ↓
Attempt 2
   ↓
failure
   ↓
~2 seconds
   ↓
Attempt 3
```

BullMQ's built-in exponential strategy calculates the retry delay from the attempt number and configured base delay. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

---

# 24. Test Permanent Failure

Now use:

```
mode = failure
```

Run:

```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"message":"Permanent failure test","mode":"failure"}' `
  http://localhost:3000/demo/jobs

$response.Content
```

The producer should return:

```
202
```

The worker should attempt the job three times.

You should see:

```
Attempt: 1
FAIL

Attempt: 2
FAIL

Attempt: 3
FAIL
```

Then:

```
FAILED
```

---

# 25. Inspect Permanent Failure

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
    "attemptsMade": 3,
    "attemptsAllowed": 3,
    "failedReason": "Intentional permanent demo failure"
  }
}
```

The job has exhausted its configured attempts.

---

# 26. Important: Retry Does Not Mean Infinite Retry

We configured:

```
attempts: 3
```

Therefore:

```
maximum attempts = 3
```

Not:

```
retry forever
```

The lifecycle is:

```
Attempt 1
   ↓
FAIL
   ↓
Attempt 2
   ↓
FAIL
   ↓
Attempt 3
   ↓
FAIL
   ↓
FAILED
```

This protects the system from infinite processing loops.

---

# 27. Break Test — `attempts: 1`

Now we intentionally remove retry behavior.

### File

```
src/queues/demo.queue.ts
```

Temporarily change:

```
attempts: 3,
```

to:

```
attempts: 1,
```

Build:

```
npm run build
```

Restart the worker:

```
npm run dev:worker
```

Create:

```
mode = failure
```

Expected:

```
Attempt 1
   ↓
FAILED
```

There should be no second attempt.

This proves:

> `attempts` controls the maximum number of processing attempts.

---

# 28. Restore `attempts: 3`

### File

```
src/queues/demo.queue.ts
```

Restore:

```
attempts: 3,
```

Keep:

```
backoff: {
  type: "exponential",
  delay: 1000
}
```

Then:

```
npm run build
```

---

# 29. Important Retry Rule

Retries are appropriate for **transient errors**.

Examples:

```
Network timeout
HTTP 502
HTTP 503
Temporary database connection failure
Temporary Redis connection issue
External service unavailable
```

But retries are usually not useful for:

```
Invalid email address
Invalid input
Permission denied
Authentication failure
Malformed payload
Business rule violation
```

For example:

```
Invalid email
   ↓
retry
   ↓
Invalid email
   ↓
retry
   ↓
Invalid email
```

Retries don't magically fix bad data.

---

# 30. Why We Should Not Retry Everything

Imagine:

```
10,000 jobs
   ↓
invalid input
```

and:

```
attempts = 10
```

You have potentially created:

```
100,000 unnecessary processing attempts
```

That wastes:

- CPU
- Redis operations
- database operations
- network requests
- external API capacity

Therefore production systems eventually distinguish:

```
Retryable error
        vs
Non-retryable error
```

We will implement that properly in a later lecture.

---

# 31. Error Must Be an `Error`

Our worker uses:

```
throw new Error(
  "Intentional failure"
);
```

This is important.

Do **not** write:

```
throw "something failed";
```

or:

```
throw {
  message: "something failed"
};
```

Use:

```
throw new Error(
  "something failed"
);
```

BullMQ expects processor exceptions to be actual `Error` objects when handling failed jobs. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

---

# 32. Retry Timeline

Our current configuration:

```
attempts = 3
delay = 1000ms
strategy = exponential
```

Conceptually:

```
                    JOB
                     │
                     ▼
                  Attempt 1
                     │
                 ┌───┴───┐
                 │       │
              success   fail
                 │       │
                 ▼       ▼
             COMPLETED  ~1 sec
                           │
                           ▼
                       Attempt 2
                           │
                       ┌───┴───┐
                       │       │
                    success   fail
                       │       │
                       ▼       ▼
                   COMPLETED  ~2 sec
                               │
                               ▼
                           Attempt 3
                               │
                           ┌───┴───┐
                           │       │
                        success   fail
                           │       │
                           ▼       ▼
                       COMPLETED  FAILED
```

---

# 33. Testing Redis Failure

This test is important because our worker has:

```
maxRetriesPerRequest: null
```

Stop Redis:

```
docker compose stop redis
```

The worker should lose its Redis connection and begin reconnecting.

You may see connection errors.

That is expected.

Now start Redis:

```
docker compose start redis
```

Verify:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

The worker should reconnect.

BullMQ's production guidance distinguishes queue operations, which normally should fail relatively quickly during a temporary disconnection, from worker connections, which are intended to keep retrying until connectivity is restored. [BullMQ](https://docs.bullmq.io/guide/going-to-production?utm_source=chatgpt.com)

---

# 34. Important Distinction: Redis Retry vs Job Retry

Do not confuse these two.

## Redis connection retry

```
Worker
  ↓
Redis unavailable
  ↓
reconnect
  ↓
Redis available
```

This is connection recovery.

---

## Job retry

```
Worker
  ↓
Processor executes
  ↓
Error
  ↓
Job retry
  ↓
Processor executes again
```

This is application/job recovery.

They are different mechanisms.

---

# 35. Build

Run:

```
npm run build
```

Expected:

```
tsc
```

with no errors.

---

# 36. Run Existing Tests

```
npm run test:run
```

All existing tests should remain green.

---

# 37. Verify API

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/health/live
```

Expected:

```
{
  "status": "ok",
  "state": "ready"
}
```

Then:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/health/ready
```

Expected:

```
{
  "status": "ready",
  "state": "ready",
  "dependencies": {
    "postgres": "connected",
    "redis": "connected"
  }
}
```

---

# 38. Final Architecture

After Lecture 6:

```
                         ┌────────────────┐
                         │   Express API  │
                         └───────┬────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │    Producer    │
                         └───────┬────────┘
                                 │
                                 ▼
                         ┌────────────────┐
                         │  BullMQ Queue  │
                         └───────┬────────┘
                                 │
                                 ▼
                              Redis
                                 │
                                 ▼
                         ┌────────────────┐
                         │     Worker     │
                         └───────┬────────┘
                                 │
                                 ▼
                            Processor
                                 │
                     ┌───────────┴───────────┐
                     │                       │
                  success                  error
                     │                       │
                     ▼                       ▼
                COMPLETED                 FAILED
                                             │
                                             ▼
                                         attempts
                                             │
                                             ▼
                                          backoff
                                             │
                                             ▼
                                         WAITING
                                             │
                                             ▼
                                          ACTIVE
```

---

# 39. Final Folder Structure

```
src/
├── config/
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

# 40. Success Criteria

Lecture 6 is complete when you can verify:

### Configuration

- `attempts: 3`
- exponential backoff configured
- base delay = 1000ms

### Successful job

- job completes
- `attemptsMade = 1`

### Transient failure

- job fails first attempt
- job retries
- job fails second attempt
- job retries again
- job succeeds on third attempt
- `attemptsMade = 3`

### Permanent failure

- job fails
- job retries
- job retries again
- job finally enters `failed`
- `attemptsMade = 3`

### Backoff

- exponential backoff observed
- retry isn't immediate

### Failure isolation

- API can return `202`
- worker can later fail the job
- job state can be inspected

### Redis

- Redis failure tested
- worker reconnect tested
- Redis recovery verified

### Project

- `npm run build`
- `npm run test:run`
- `/health/live`
- `/health/ready`

---

# 41. What We Deliberately Do NOT Implement Yet

We have **not** implemented:

```
❌ retryable error classification
❌ UnrecoverableError
❌ jitter
❌ custom backoff
❌ dead-letter queue
❌ manual retry API
❌ job cleanup policies
❌ retry metrics
❌ QueueEvents
❌ concurrency
❌ rate limiting
❌ idempotency
```

We are keeping the learning progression deliberate.

---

# 42. Key Concepts to Remember

### `attempts`

Maximum number of processing attempts.

```
attempts: 3
```

means:

```
1 + retry + retry
```

for a maximum of three processing attempts. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

### `backoff`

Controls how long BullMQ waits before retrying.

### Fixed

```
1s
1s
1s
```

### Exponential

```
1s
2s
4s
8s
```

BullMQ currently provides built-in fixed and exponential backoff strategies. [BullMQ](https://docs.bullmq.io/guide/retrying-failing-jobs?utm_source=chatgpt.com)

### `attemptsMade`

Tracks processing attempts already made.

### Retry

```
FAILED
  ↓
WAITING
  ↓
ACTIVE
```

Automatic retry and manually calling `job.retry()` are separate mechanisms; manual retry is for explicitly reprocessing a completed/failed job. [BullMQ](https://docs.bullmq.io/guide/jobs/retrying-job?utm_source=chatgpt.com)

---

# 43. Final Mental Model

Memorize this:

```
                  JOB CREATED
                       │
                       ▼
                    WAITING
                       │
                       ▼
                     ACTIVE
                       │
                 ┌─────┴─────┐
                 │           │
              SUCCESS       ERROR
                 │           │
                 ▼           ▼
             COMPLETED     FAILED
                               │
                               ▼
                            attempts?
                           /        \
                         yes         no
                          │           │
                          ▼           ▼
                       backoff      FAILED
                          │
                          ▼
                       WAITING
                          │
                          ▼
                       ACTIVE
```

The central idea:

> **Retries are not simply “run the function again.” They are a controlled state transition governed by attempt limits and backoff policy.**
