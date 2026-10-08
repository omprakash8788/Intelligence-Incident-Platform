# Module 2 — Lecture 7: BullMQ Retry Policies, Jitter & Non-Retryable Errors

> **Project:** Production Intelligence & Incident Platform
> **Stack:** Node.js + TypeScript + Express + PostgreSQL + Redis + BullMQ
> **Learning mode:** Build → Test → Break → Understand → Fix → Verify
> **Prerequisite:** Module 2 — Lecture 6: BullMQ Job Failures, Retries & Exponential Backoff

---

# Table of Contents

1. [What We Already Have](#1-what-we-already-have)
2. [What We Will Build](#2-what-we-will-build)
3. [Why Retry Policies Need More Than Attempts](#3-why-retry-policies-need-more-than-attempts)
4. [Retryable vs Non-Retryable Errors](#4-retryable-vs-non-retryable-errors)
5. [Jitter](#5-jitter)
6. [Architecture](#6-architecture)
7. [Step 1 — Create Typed Job Errors](#7-step-1--create-typed-job-errors)
8. [Step 2 — Update Demo Job Modes](#8-step-2--update-demo-job-modes)
9. [Step 3 — Update the Worker](#9-step-3--update-the-worker)
10. [Step 4 — Configure Retry Policy](#10-step-4--configure-retry-policy)
11. [Step 5 — Update API Validation](#11-step-5--update-api-validation)
12. [Step 6 — Update Job Status](#12-step-6--update-job-status)
13. [Step 7 — Build](#13-step-7--build)
14. [Step 8 — Test Normal Success](#14-step-8--test-normal-success)
15. [Step 9 — Test Retryable Failure](#15-step-9--test-retryable-failure)
16. [Step 10 — Test Non-Retryable Failure](#16-step-10--test-non-retryable-failure)
17. [Step 11 — Understand Jitter](#17-step-11--understand-jitter)
18. [Step 12 — Intentional Break Test](#18-step-12--intentional-break-test)
19. [Step 13 — Verify Recovery](#19-step-13--verify-recovery)
20. [Production Rules](#20-production-rules)
21. [Final Folder Structure](#21-final-folder-structure)
22. [Success Criteria](#22-success-criteria)
23. [What Comes Next](#23-what-comes-next)

---

# 1. What We Already Have

From Lecture 6, our queue already supports:

```
attempts = 3
backoff = exponential
base delay = 1000 ms
```

Our current retry flow is:

```
Producer
   │
   ▼
BullMQ Queue
   │
   ▼
Worker
   │
   ├── success ───────────────► COMPLETED
   │
   └── error
        │
        ▼
   attempts remaining?
      │          │
     yes         no
      │           │
      ▼           ▼
   WAITING      FAILED
      │
      ▼
   Worker retry
```

But there is an important production problem.

Not every error should be retried.

For example:

```
Invalid email address
```

Retrying this 3 times does not fix anything.

But:

```
Redis temporarily unavailable
```

might succeed on the second attempt.

Therefore we need to distinguish:

```
Retryable Error
```

from:

```
Non-Retryable Error
```

---

# 2. What We Will Build

In this lecture we will introduce:

```
                    Job Error
                       │
             ┌─────────┴─────────┐
             │                   │
        Retryable           Non-Retryable
             │                   │
             ▼                   ▼
        Retry job             Fail immediately
             │
             ▼
      Exponential Backoff
             │
             ▼
           Jitter
```

We will create three important behaviors.

### Case 1 — Success

```
success
  ↓
COMPLETED
```

### Case 2 — Retryable error

```
retryable
   ↓
FAILED ATTEMPT
   ↓
backoff + jitter
   ↓
retry
   ↓
success
```

### Case 3 — Non-retryable error

```
non-retryable
      ↓
FAILED
```

No retry.

---

# 3. Why Retry Policies Need More Than Attempts

Suppose 1,000 jobs fail because an external service is temporarily unavailable.

Without jitter:

```
Job 1 → retry after 1 sec
Job 2 → retry after 1 sec
Job 3 → retry after 1 sec
...
Job 1000 → retry after 1 sec
```

They all wake up together.

This can create:

```
1000 requests
      ↓
External service
      ↓
overload
      ↓
more failures
      ↓
more retries
      ↓
more overload
```

This is called a **retry storm**.

Jitter adds randomness.

Instead of:

```
1000 ms
```

we might get:

```
843 ms
1172 ms
934 ms
1401 ms
1022 ms
...
```

The retry traffic becomes distributed over time.

---

# 4. Retryable vs Non-Retryable Errors

We will introduce a typed error.

There are two categories:

```
RetryableJobError
NonRetryableJobError
```

For example:

| Error                         | Retry? |
| ----------------------------- | ------ |
| Temporary network failure     | ✅      |
| External API timeout          | ✅      |
| Redis temporarily unavailable | ✅      |
| Database connection failure   | ✅      |
| Invalid input                 | ❌      |
| Invalid email                 | ❌      |
| Missing required field        | ❌      |
| Permission denied             | ❌      |
| Unsupported operation         | ❌      |

The important rule is:

> **Do not retry an error merely because an exception occurred.**

The application must understand whether retrying makes sense.

---

# 5. Jitter

We currently have exponential backoff:

```
attempt 1 → 1000 ms
attempt 2 → 2000 ms
attempt 3 → 4000 ms
```

Jitter changes the actual delay.

Conceptually:

```
exponential delay
        +
random variation
        =
jittered retry delay
```

For example:

```
attempt 1
1000 ms + random variation

attempt 2
2000 ms + random variation

attempt 3
4000 ms + random variation
```

This prevents large numbers of jobs from retrying simultaneously.

---

# 6. Architecture

Our queue architecture now becomes:

```
                  HTTP API
                     │
                     ▼
              Demo Job Producer
                     │
                     ▼
              ┌──────────────┐
              │ BullMQ Queue │
              └──────┬───────┘
                     │
                     ▼
                 Worker
                     │
             ┌───────┴────────┐
             │                │
             ▼                ▼
        Retryable         Non-Retryable
           Error              Error
             │                │
             ▼                ▼
        Backoff + Jitter    FAILED
             │
             ▼
           Retry
             │
             ▼
          Worker
```

---

# 7. Step 1 — Create Typed Job Errors

We don't want the worker to throw random strings and then inspect error messages.

Bad:

```
throw new Error(
  "temporary problem"
);
```

Then:

```
if (
  error.message.includes("temporary")
) {
   // retry
}
```

This is fragile.

Instead, create explicit error types.

## Create this file

**File: `src/errors/job.errors.ts`**

```
export class RetryableJobError
  extends Error {

  public readonly retryable =
    true;

  constructor(
    message: string
  ) {
    super(message);

    this.name =
      "RetryableJobError";

    Object.setPrototypeOf(
      this,
      RetryableJobError.prototype
    );
  }
}

export class NonRetryableJobError
  extends Error {

  public readonly retryable =
    false;

  constructor(
    message: string
  ) {
    super(message);

    this.name =
      "NonRetryableJobError";

    Object.setPrototypeOf(
      this,
      NonRetryableJobError.prototype
    );
  }
}
```

We now have:

```
RetryableJobError
        │
        └── retryable = true

NonRetryableJobError
        │
        └── retryable = false
```

---

# 8. Step 2 — Update Demo Job Modes

We need additional modes to demonstrate the behavior.

## Replace this file

**File: `src/queues/jobs/demo.job.ts`**

```
export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}
```

We now have:

```
success
slow
failure
fail-twice
retryable
non-retryable
```

---

# 9. Step 3 — Update the Worker

The worker is where we decide whether the job failure is retryable.

## Replace this file

**File: `src/workers/demo.worker.ts`**

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

import {
  RetryableJobError,
  NonRetryableJobError
} from "../errors/job.errors.js";

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

      const attempt =
        job.attemptsMade + 1;

      console.log(
        `[DemoWorker] Processing job ${job.id}`
      );

      console.log(
        `[DemoWorker] Attempt: ${attempt}`
      );

      console.log(
        `[DemoWorker] Mode: ${job.data.mode}`
      );

      console.log(
        `[DemoWorker] Message: ${job.data.message}`
      );

      /*
       * Permanent failure.
       *
       * This error is intentionally
       * treated as non-retryable.
       */
      if (
        job.data.mode ===
        "non-retryable"
      ) {
        throw new NonRetryableJobError(
          "Invalid job data. This error must not be retried."
        );
      }

      /*
       * Retryable failure.
       *
       * This error is intentionally
       * retryable.
       */
      if (
        job.data.mode ===
        "retryable"
      ) {

        if (
          job.attemptsMade < 2
        ) {
          throw new RetryableJobError(
            `Temporary failure on attempt ${attempt}`
          );
        }
      }

      /*
       * Existing permanent failure
       * from previous lectures.
       */
      if (
        job.data.mode ===
        "failure"
      ) {
        throw new NonRetryableJobError(
          "Intentional permanent demo failure"
        );
      }

      /*
       * Existing transient failure.
       *
       * Fail twice, then succeed.
       */
      if (
        job.data.mode ===
        "fail-twice"
      ) {

        if (
          job.attemptsMade < 2
        ) {
          throw new RetryableJobError(
            `Intentional transient failure on attempt ${attempt}`
          );
        }
      }

      /*
       * Slow job.
       */
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

      console.log(
        `[DemoWorker] Job ${job.id} succeeded on attempt ${attempt}`
      );

      return {
        processed: true,
        attempt
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
        errorType:
          error.name,

        message:
          error.message,

        attemptsMade:
          job?.attemptsMade,

        attemptsAllowed:
          job?.opts.attempts
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

# 10. Step 4 — Configure Retry Policy

Our queue already has:

```
attempts: 3
```

and:

```
exponential backoff
```

Now we need to discuss an important BullMQ behavior.

BullMQ's normal retry mechanism is based on a job failing.

Therefore, **the worker must prevent retryable/non-retryable classification from being ambiguous**.

For this lecture, we will implement the classification directly inside the worker.

The queue configuration remains:

## File: `src/queues/demo.queue.ts`

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

### Important

BullMQ will retry a thrown error.

Therefore:

```
throw RetryableJobError
```

means:

```
job fails
   ↓
BullMQ sees attempts remaining
   ↓
backoff
   ↓
retry
```

But:

```
throw NonRetryableJobError
```

by itself does **not automatically tell BullMQ** to stop retrying.

This is a very important production concept.

BullMQ sees both as:

```
Promise rejected
```

Therefore, if we want true non-retryable behavior, we must explicitly control the retry decision.

---

# 11. Step 5 — Implement Non-Retryable Retry Control

BullMQ provides a mechanism for this through the worker's retry strategy.

We can use the `UnrecoverableError` class from BullMQ.

This is the correct way to tell BullMQ:

> This job failed, but do not retry it.

Update the worker imports.

## File: `src/workers/demo.worker.ts`

Change:

```
import {
  RetryableJobError,
  NonRetryableJobError
} from "../errors/job.errors.js";
```

to:

```
import {
  UnrecoverableError
} from "bullmq";

import {
  RetryableJobError,
  NonRetryableJobError
} from "../errors/job.errors.js";
```

Now change the non-retryable sections.

Replace:

```
throw new NonRetryableJobError(
  "Invalid job data. This error must not be retried."
);
```

with:

```
const error =
  new NonRetryableJobError(
    "Invalid job data. This error must not be retried."
  );

throw new UnrecoverableError(
  error.message
);
```

And replace:

```
throw new NonRetryableJobError(
  "Intentional permanent demo failure"
);
```

with:

```
const error =
  new NonRetryableJobError(
    "Intentional permanent demo failure"
  );

throw new UnrecoverableError(
  error.message
);
```

So the important production pattern is:

```
Application error
       │
       ▼
Is it retryable?
       │
   ┌───┴────┐
   │        │
  YES       NO
   │        │
   ▼        ▼
throw      throw
normal     UnrecoverableError
error
   │        │
   ▼        ▼
BullMQ     BullMQ
retries    stops retrying
```

---

# 12. Step 6 — Update API Validation

Our route must accept the new modes.

## Replace this validation

**File: `src/routes/demo-queue.routes.ts`**

Find:

```
if (
  mode !== "success" &&
  mode !== "slow" &&
  mode !== "failure" &&
  mode !== "fail-twice"
)
```

Replace it with:

```
if (
  mode !== "success" &&
  mode !== "slow" &&
  mode !== "failure" &&
  mode !== "fail-twice" &&
  mode !== "retryable" &&
  mode !== "non-retryable"
)
```

Then replace the validation message:

```
message:
  "mode must be success, slow, failure, or fail-twice"
```

with:

```
message:
  "mode must be success, slow, failure, fail-twice, retryable, or non-retryable"
```

The full validation section should now be:

**File: `src/routes/demo-queue.routes.ts`**

```
if (
  mode !== "success" &&
  mode !== "slow" &&
  mode !== "failure" &&
  mode !== "fail-twice" &&
  mode !== "retryable" &&
  mode !== "non-retryable"
) {
  res.status(400).json({
    success: false,
    error: {
      code:
        "INVALID_MODE",
      message:
        "mode must be success, slow, failure, fail-twice, retryable, or non-retryable"
    }
  });

  return;
}
```

---

# 13. Step 7 — Build

First compile TypeScript.

### Command

```
npm run build
```

Expected:

```
> production-intelligence-platform@1.0.0 build
> tsc
```

There should be no TypeScript errors.

---

# 14. Step 8 — Test Normal Success

Start the application.

### Terminal 1

```
npm run dev
```

### Terminal 2

```
npm run dev:worker
```

Now submit:

```
$body = @{
  message = "Lecture 7 success test"
  mode = "success"
} | ConvertTo-Json

Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs `
  -ContentType "application/json" `
  -Body $body
```

You should receive:

```
{
  "success": true,
  "data": {
    "jobId": "..."
  }
}
```

Copy the `jobId`.

Then:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/YOUR_JOB_ID
```

Expected:

```
{
  "success": true,
  "data": {
    "id": "...",
    "name": "demo-job",
    "state": "completed",
    "attemptsMade": 1,
    "attemptsAllowed": 3
  }
}
```

The worker should log:

```
Attempt: 1
Job ... succeeded on attempt 1
```

---

# 15. Step 9 — Test Retryable Failure

Now test:

```
retryable
```

### PowerShell

```
$body = @{
  message = "Lecture 7 retryable test"
  mode = "retryable"
} | ConvertTo-Json

Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs `
  -ContentType "application/json" `
  -Body $body
```

Copy the returned `jobId`.

Immediately inspect it:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/YOUR_JOB_ID
```

You may see:

```
waiting
```

or:

```
active
```

or:

```
failed
```

depending on timing.

Eventually:

```
completed
```

The worker should show something similar to:

```
Attempt: 1
Temporary failure on attempt 1
```

Then:

```
Attempt: 2
Temporary failure on attempt 2
```

Then:

```
Attempt: 3
Job succeeded on attempt 3
```

The final status should show:

```
{
  "state": "completed",
  "attemptsMade": 3,
  "attemptsAllowed": 3
}
```

This demonstrates:

```
failure
   ↓
retry
   ↓
failure
   ↓
retry
   ↓
success
```

---

# 16. Step 10 — Test Non-Retryable Failure

Now submit:

```
non-retryable
```

### PowerShell

```
$body = @{
  message = "Lecture 7 permanent failure test"
  mode = "non-retryable"
} | ConvertTo-Json

Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs `
  -ContentType "application/json" `
  -Body $body
```

Copy the `jobId`.

Inspect it:

```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/demo/jobs/YOUR_JOB_ID
```

Expected final state:

```
{
  "success": true,
  "data": {
    "state": "failed",
    "attemptsMade": 1,
    "attemptsAllowed": 3
  }
}
```

The critical observation is:

```
attemptsMade = 1
```

even though:

```
attemptsAllowed = 3
```

That proves the job was **not retried**.

---

# 17. Step 11 — Understand Jitter

Now let's understand an important distributed-systems problem.

Imagine:

```
10,000 jobs
```

all fail at:

```
12:00:00
```

Without jitter:

```
12:00:01 → 10,000 retries
```

This is dangerous.

With jitter:

```
12:00:00.7 → 800 retries
12:00:01.1 → 1,100 retries
12:00:01.5 → 900 retries
12:00:01.9 → 1,200 retries
...
```

Traffic becomes distributed.

Conceptually:

```
NO JITTER

Requests
  │
  │       █
  │       █
  │       █
  │       █
  └─────────────── Time
          ↑
       retry storm
```

With jitter:

```
Requests
  │
  │   █
  │      █
  │ █
  │         █
  │     █
  └─────────────── Time
```

The second pattern is much safer for distributed systems.

---

# 18. BullMQ Jitter Configuration

BullMQ supports jitter in its backoff configuration.

The concept is:

```
backoff: {
  type: "exponential",
  delay: 1000,
  jitter: 0.5
}
```

The important idea is that jitter introduces randomness into the retry delay.

However, before enabling it blindly in the production platform, we need to understand exactly how the installed BullMQ version interprets the jitter value.

Check your installed version:

```
npm list bullmq
```

You should see something like:

```
bullmq@...
```

For this lecture, the important architectural principle is:

```
retry policy
    +
exponential backoff
    +
jitter
    =
distributed retry protection
```

Do not confuse this with Redis connection retry.

We now have **two completely different retry mechanisms**:

### Redis connection retry

```
Redis unavailable
      ↓
ioredis retryStrategy
      ↓
reconnect
```

### Job retry

```
Job failed
      ↓
BullMQ attempts
      ↓
backoff
      ↓
retry job
```

They solve different problems.

---

# 19. Step 12 — Intentional Break Test

Now we intentionally remove the non-retryable behavior.

## Break it

In:

**File: `src/workers/demo.worker.ts`**

Temporarily replace:

```
throw new UnrecoverableError(
  error.message
);
```

with:

```
throw error;
```

Now the code is:

```
const error =
  new NonRetryableJobError(
    "Invalid job data. This error must not be retried."
  );

throw error;
```

Build:

```
npm run build
```

Restart the worker.

Now submit:

```
$body = @{
  message = "Intentional break test"
  mode = "non-retryable"
} | ConvertTo-Json

Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs `
  -ContentType "application/json" `
  -Body $body
```

Now inspect the job.

You should observe that the job can be retried because BullMQ only sees:

```
Promise rejected
```

It does not automatically know:

```
this is a business-level permanent error
```

This is exactly why explicit retry policy is necessary.

---

# 20. Fix the Break

Restore:

```
const error =
  new NonRetryableJobError(
    "Invalid job data. This error must not be retried."
  );

throw new UnrecoverableError(
  error.message
);
```

Do the same for the permanent failure mode.

Then:

```
npm run build
```

Restart the worker.

Test again.

The result must be:

```
attempt 1
   ↓
FAILED
```

and **not**:

```
attempt 1
   ↓
attempt 2
   ↓
attempt 3
```

---

# 21. Important Production Lesson

There are actually three levels of retry policy.

## Level 1 — Infrastructure retry

Example:

```
Redis connection
PostgreSQL connection
HTTP connection
```

These are infrastructure-level retries.

---

## Level 2 — Job retry

Example:

```
BullMQ attempts = 3
```

This determines how many times the job can execute.

---

## Level 3 — Business retry policy

Example:

```
Invalid email
```

should not retry.

But:

```
Email provider timeout
```

should retry.

Therefore:

```
                 Retry Policy
                      │
          ┌───────────┼───────────┐
          │           │           │
   Infrastructure    Job       Business
      retry         retry       policy
```

Production systems need all three concepts.

---

# 22. What We Should NOT Do

Do not write:

```
catch (error) {
  retry();
}
```

for everything.

Do not write:

```
attempts: 20
```

and assume the system is reliable.

Do not retry:

```
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
invalid business input
schema validation errors
```

without a specific reason.

Retrying permanent failures wastes:

```
CPU
Redis
database connections
network traffic
worker capacity
external API quota
```

---

# 23. Recommended Retry Classification

For our future production platform:

```
Error
 │
 ├── Validation Error
 │       └── NO RETRY
 │
 ├── Authentication Error
 │       └── NO RETRY
 │
 ├── Authorization Error
 │       └── NO RETRY
 │
 ├── Resource Not Found
 │       └── usually NO RETRY
 │
 ├── Database transient error
 │       └── RETRY
 │
 ├── Network timeout
 │       └── RETRY
 │
 ├── External service 5xx
 │       └── RETRY
 │
 └── External service 429
         └── RETRY with controlled backoff
```

This classification becomes extremely important when we build incident processing.

---

# 24. Retry Storm Example

Imagine our platform receives:

```
10,000 incidents
```

and an external dependency goes down.

Every job fails.

Without jitter:

```
10,000 jobs
     ↓
retry after 1 second
     ↓
10,000 requests
     ↓
dependency still down
     ↓
retry after 2 seconds
     ↓
10,000 requests
```

This can become:

```
failure
   ↓
retry
   ↓
overload
   ↓
failure
   ↓
retry
   ↓
more overload
```

This is called a **retry storm**.

Jitter helps break synchronization.

---

# 25. Final Retry Model

Our system now conceptually works like this:

```
                     Job
                      │
                      ▼
                   Worker
                      │
                      ▼
                   Error?
                 /        \
               NO          YES
               │            │
               ▼            ▼
           COMPLETED    Classify
                           │
                    ┌──────┴──────┐
                    │             │
                Retryable     Non-Retryable
                    │             │
                    ▼             ▼
             attempts left?     FAILED
                /     \
              YES      NO
               │        │
               ▼        ▼
         backoff+jitter FAILED
               │
               ▼
             retry
```

---

# 26. Final Folder Structure

After Lecture 7:

```
src/
├── config/
│   ├── config.types.ts
│   ├── env.ts
│   └── rate-limit.ts
│
├── controllers/
│   ├── health.controller.ts
│   └── incident.controller.ts
│
├── database/
│   ├── migrations/
│   ├── health.ts
│   ├── migrate.ts
│   ├── pool.ts
│   └── transaction.ts
│
├── domain/
│   ├── incident.ts
│   ├── incident-query.ts
│   └── pagination.ts
│
├── errors/
│   ├── AppError.ts
│   ├── NotFoundError.ts
│   ├── ValidationError.ts
│   └── job.errors.ts
│
├── logging/
│
├── middleware/
│
├── redis/
│
├── repositories/
│
├── routes/
│   ├── health.routes.ts
│   ├── incident.routes.ts
│   └── demo-queue.routes.ts
│
├── server/
│
├── services/
│   ├── incident.service.ts
│   ├── redis.service.ts
│   └── demo-job.service.ts
│
├── types/
│
├── utils/
│
├── validators/
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
├── workers/
│   └── demo.worker.ts
│
├── app.ts
├── container.ts
├── server.ts
└── workers.ts
```

---

# 27. Verification Checklist

Run:

```
npm run build
```

Then verify:

### Success

```
success
→ completed
→ attemptsMade = 1
```

### Retryable

```
retryable
→ attempt 1
→ retry
→ attempt 2
→ retry
→ attempt 3
→ completed
```

### Non-retryable

```
non-retryable
→ attempt 1
→ failed
→ no retry
```

### Permanent failure

```
failure
→ attempt 1
→ failed
→ no retry
```

### Existing transient failure

```
fail-twice
→ attempt 1
→ retry
→ attempt 2
→ retry
→ attempt 3
→ completed
```

---

# 28. Success Criteria

Lecture 7 is complete only when all of these are true:

- `npm run build` succeeds.
- Success jobs complete on the first attempt.
- Retryable errors are retried.
- Retryable errors respect `attempts`.
- Exponential backoff is active.
- Non-retryable errors stop immediately.
- `UnrecoverableError` behavior is understood.
- Intentional break test was performed.
- Broken non-retryable behavior was observed.
- Fix was restored.
- Final non-retryable test succeeds.
- Redis connection retry and BullMQ job retry are understood as separate mechanisms.
- Jitter's purpose is understood.
- Retry storms are understood.

---

# 29. Key Takeaways

The most important concepts from this lecture are:

```
1. Not every failure should be retried.

2. Retryable errors need controlled retries.

3. Non-retryable errors should fail immediately.

4. Exponential backoff prevents immediate retry storms.

5. Jitter prevents synchronized retries.

6. BullMQ job retry ≠ Redis connection retry.

7. "attempts: 3" alone is not a complete retry policy.

8. Business-level error classification matters.
```

The production mindset is:

```
                    FAILURE
                       │
                       ▼
                Should we retry?
                  /          \
                YES            NO
                 │              │
                 ▼              ▼
          backoff + jitter    FAILED
                 │
                 ▼
              retry
                 │
                 ▼
             SUCCESS
```
