# Lecture 8 — BullMQ Delayed Jobs & Scheduled Execution

**Goal:** Learn how to schedule background work for a future time using BullMQ, inspect delayed jobs, cancel them safely, and verify their lifecycle.

We will follow your preferred workflow:

**Build → Test → Break intentionally → Understand failure → Fix → Verify**

This lecture builds on the existing Node.js, TypeScript, Express, Redis, and BullMQ project. We will extend your existing demo queue rather than create a second queue unnecessarily.

## Table of contents

1. [What delayed jobs solve](#1-what-delayed-jobs-solve)
2. [Understand the job lifecycle](#2-understand-the-job-lifecycle)
3. [Check your current project](#3-check-your-current-project)
4. [Update the job types](#4-update-the-job-types)
5. [Update the producer](#5-update-the-producer)
6. [Update the job status service](#6-update-the-job-status-service)
7. [Add delayed-job API routes](#7-add-delayed-job-api-routes)
8. [Confirm route registration](#8-confirm-route-registration)
9. [Update the worker for delayed jobs](#9-update-the-worker-for-delayed-jobs)
10. [Build and start the application](#10-build-and-start-the-application)
11. [Test delayed execution](#11-test-delayed-execution)
12. [Test invalid delays](#12-test-invalid-delays)
13. [Test cancellation](#13-test-cancellation)
14. [Intentional break test](#14-intentional-break-test)
15. [Production patterns and success criteria](#15-production-patterns-and-success-criteria)

## 1. What delayed jobs solve

Imagine our incident platform detects a critical incident.

We may want to:

- Send a reminder if nobody acknowledges it within 2 minutes.
- Escalate the incident after 10 minutes.
- Run a follow-up check 30 seconds after remediation.
- Schedule a retry after an external service recovers.

We should not keep an HTTP request open while waiting. Instead, we create a job in Redis through BullMQ and let a worker process it when it becomes eligible.

### Lifecycle overview

1. **API request:** Create a job with a delay of 30 seconds.
2. **Redis / BullMQ:** The job remains delayed until eligible.
3. **Worker:** Processes the job when it becomes eligible and a worker is available.
4. **Completed or failed:** The worker records the outcome.

A delayed job is not guaranteed to execute at an exact millisecond. The delay makes it eligible after the specified time; worker availability and system load affect when processing actually starts.

## 2. Understand the job lifecycle

A delayed job follows this approximate lifecycle:

```text
POST /demo/jobs/delayed
          |
          v
       DELAYED
          |
          | delay expires
          v
        WAITING
          |
          v
         ACTIVE
          |
       +--+--+
       |     |
       v     v
  COMPLETED FAILED
```

A delayed job can also be removed before it begins processing, provided it is still in a state where BullMQ permits removal.

Important distinction:

- **Delayed job:** Waiting for its scheduled execution time.
- **Retry backoff:** A previously failed job waiting before another attempt.
- **Repeatable or recurring job:** A job configured to run repeatedly according to a schedule.

Today we focus on one-time delayed jobs.

## 3. Check your current project

Open PowerShell in your project directory.

**Project directory**

```powershell
cd D:\Production-Intelligence-Incident-Platform\production-intelligence-platform
```

Check BullMQ is installed.

**Command**

```powershell
npm list bullmq
```

Check your existing build.

**Command**

```powershell
npm run build
```

Fix any existing compilation errors before continuing.

## 4. Update the job types

We will support the existing job modes and add a delay-specific mode for testing.

Replace `src/queues/jobs/demo.job.ts` with:

```typescript
export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable"
  | "delayed";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}
```

The `delayed` mode lets us identify these jobs in our demo worker. The actual scheduling is controlled by BullMQ's `delay` option, not by the mode.

## 5. Update the producer

BullMQ accepts a delay in milliseconds when adding a job.

For example:

```typescript
await demoQueue.add(
  "demo-job",
  {
    message: "Run later",
    mode: "delayed"
  },
  {
    delay: 30_000
  }
);
```

This makes the job eligible approximately 30 seconds after scheduling.

We will add a reusable producer function while preserving the existing `addDemoJob` function.

Replace `src/queues/producers/demo.producer.ts` with:

```typescript
import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData
} from "../jobs/demo.job.js";

export interface AddDemoJobOptions {
  delayMs?: number;
}

export const addDemoJob = async (
  data: DemoJobData,
  options: AddDemoJobOptions = {}
): Promise<string> => {
  const delayMs =
    options.delayMs ?? 0;

  if (
    !Number.isInteger(delayMs) ||
    delayMs < 0
  ) {
    throw new Error(
      "delayMs must be a non-negative integer"
    );
  }

  const job = await demoQueue.add(
    "demo-job",
    data,
    delayMs > 0
      ? { delay: delayMs }
      : {}
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return job.id;
};
```

### Why validate the delay?

Without validation, clients could send invalid values such as negative delays or fractional milliseconds. The API will also validate the value, but keeping a guard at the producer boundary protects internal callers too.

## 6. Update the job status service

We want to inspect the current state of a job, including its attempts and any failure reason.

Replace `src/services/demo-job.service.ts` with:

```typescript
import type {
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
  delay: number;
  timestamp: number;
  processedOn: number | undefined;
  finishedOn: number | undefined;
}

export const getDemoJobStatus =
  async (
    jobId: string
  ): Promise<DemoJobStatus | null> => {
    const job =
      await demoQueue.getJob(jobId);

    if (!job) {
      return null;
    }

    const state =
      await job.getState();

    return {
      id: job.id ?? jobId,
      name: job.name,
      state,
      data: job.data,
      result: job.returnvalue,
      attemptsMade: job.attemptsMade,
      attemptsAllowed: job.opts.attempts ?? 1,
      failedReason: job.failedReason,
      delay: job.delay,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn
    };
  };
```

The `delay` field is the job's configured delay in milliseconds. The timestamps help us investigate when the job was created, processed, and finished.

**Important:** Completed and failed jobs may eventually be removed according to queue retention settings. A status lookup can return `404` if a job no longer exists in Redis.

## 7. Add delayed-job API routes

We will expose three endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/demo/jobs/delayed` | Schedule a delayed job |
| `GET` | `/demo/jobs/:jobId` | Inspect a job |
| `DELETE` | `/demo/jobs/:jobId` | Attempt to remove a job |

Your existing GET route is already present. We will add the POST and DELETE routes without duplicating it.

Replace `src/routes/demo-queue.routes.ts` with:

```typescript
import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

import {
  getDemoJobStatus
} from "../services/demo-job.service.js";

import {
  demoQueue
} from "../queues/demo.queue.js";

import type {
  DemoJobMode
} from "../queues/jobs/demo.job.js";

const router = Router();

const isDemoJobMode = (
  value: unknown
): value is DemoJobMode => {
  return (
    value === "success" ||
    value === "slow" ||
    value === "failure" ||
    value === "fail-twice" ||
    value === "retryable" ||
    value === "non-retryable" ||
    value === "delayed"
  );
};

router.post(
  "/demo/jobs",
  async (req, res, next) => {
    try {
      const {
        message,
        mode
      } = req.body as {
        message?: unknown;
        mode?: unknown;
      };

      if (
        typeof message !== "string" ||
        message.trim() === ""
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

      if (!isDemoJobMode(mode)) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_MODE",
            message:
              "mode is not supported"
          }
        });
        return;
      }

      const jobId = await addDemoJob({
        message: message.trim(),
        mode
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

router.post(
  "/demo/jobs/delayed",
  async (req, res, next) => {
    try {
      const {
        message,
        delayMs
      } = req.body as {
        message?: unknown;
        delayMs?: unknown;
      };

      if (
        typeof message !== "string" ||
        message.trim() === ""
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

      if (
        typeof delayMs !== "number" ||
        !Number.isInteger(delayMs) ||
        delayMs < 1000 ||
        delayMs > 86_400_000
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_DELAY",
            message:
              "delayMs must be an integer between 1000 and 86400000"
          }
        });
        return;
      }

      const jobId = await addDemoJob(
        {
          message: message.trim(),
          mode: "delayed"
        },
        {
          delayMs
        }
      );

      res.status(202).json({
        success: true,
        data: {
          jobId,
          state: "scheduled",
          delayMs
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/demo/jobs/:jobId",
  async (req, res, next) => {
    try {
      const job =
        await getDemoJobStatus(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code: "JOB_NOT_FOUND",
            message: "Demo job not found"
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

router.delete(
  "/demo/jobs/:jobId",
  async (req, res, next) => {
    try {
      const job =
        await demoQueue.getJob(
          req.params.jobId
        );

      if (!job) {
        res.status(404).json({
          success: false,
          error: {
            code: "JOB_NOT_FOUND",
            message: "Demo job not found"
          }
        });
        return;
      }

      const state =
        await job.getState();

      if (state !== "delayed") {
        res.status(409).json({
          success: false,
          error: {
            code: "JOB_NOT_DELAYED",
            message:
              "Only jobs currently in the delayed state can be cancelled by this endpoint"
          }
        });
        return;
      }

      await job.remove();

      res.status(200).json({
        success: true,
        data: {
          jobId: req.params.jobId,
          cancelled: true
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

### Cancellation behavior

This endpoint only removes jobs currently in the `delayed` state. Once a job becomes active, this implementation refuses cancellation rather than pretending the work was stopped.

A production cancellation design needs to handle races between checking the state and removing the job, and must define what cancellation means if processing has already started.

## 8. Confirm route registration

Your `src/app.ts` should already register the demo queue router from earlier lectures.

Check `src/app.ts` contains the following import and registration. Do not add duplicates.

```typescript
import demoQueueRoutes from "./routes/demo-queue.routes.js";
```

And, alongside your other route registrations:

```typescript
app.use(demoQueueRoutes);
```

Keep the existing middleware order and error-handler registration unchanged.

## 9. Update the worker for delayed jobs

Your existing worker handles the `"delayed"` mode automatically through its normal success path, but add a clear log so you can observe when the job actually starts.

File: `src/workers/demo.worker.ts`

Inside the processor function, after the existing attempt and message logs, add:

```typescript
if (job.data.mode === "delayed") {
  console.log(
    `[DemoWorker] Delayed job ${job.id} is now being processed`
  );
}
```

Do not replace your existing retry and `UnrecoverableError` handling from Lecture 7. The new block is additive.

A delayed job should eventually return the same successful result as your existing worker:

```typescript
return {
  processed: true,
  attempt
};
```

If your local worker uses a different variable name for the attempt number, retain your existing variable and return type.

## 10. Build and start the application

**PowerShell — project root**

```powershell
npm run build
```

Start the API in Terminal 1:

```powershell
npm run dev
```

Start the worker in Terminal 2:

```powershell
npm run dev:worker
```

If you are testing through Docker instead, rebuild and recreate the services using your existing Compose configuration. Avoid running duplicate API or worker processes against the same project without understanding which process is consuming jobs.

## 11. Test delayed execution

We'll schedule a job for five seconds in the future.

**PowerShell — schedule a delayed job**

```powershell
$body = @{
  message = "Lecture 8 delayed execution test"
  delayMs = 5000
} | ConvertTo-Json

$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs/delayed `
  -ContentType "application/json" `
  -Body $body

$response.Content
```

Expected response shape:

```json
{
  "success": true,
  "data": {
    "jobId": "YOUR_JOB_ID",
    "state": "scheduled",
    "delayMs": 5000
  }
}
```

Save the ID.

**PowerShell — save the returned ID**

```powershell
$result = $response.Content | ConvertFrom-Json
$jobId = $result.data.jobId
$jobId
```

Immediately inspect the job:

**PowerShell — inspect the scheduled job**

```powershell
Invoke-WebRequest `
  -UseBasicParsing `
  "http://localhost:3000/demo/jobs/$jobId"
```

The state will typically be `delayed` if inspected promptly. If the worker or machine is busy, processing may start after the scheduled time rather than exactly at five seconds.

Wait five seconds:

**PowerShell — wait**

```powershell
Start-Sleep -Seconds 5
```

Inspect again:

**PowerShell — inspect after the delay**

```powershell
Invoke-WebRequest `
  -UseBasicParsing `
  "http://localhost:3000/demo/jobs/$jobId"
```

Expected eventual result:

```json
{
  "success": true,
  "data": {
    "state": "completed",
    "attemptsMade": 1,
    "attemptsAllowed": 3,
    "result": {
      "processed": true,
      "attempt": 1
    }
  }
}
```

Your actual response includes other fields, such as `id`, `data`, and timestamps. The important checks are the state and successful result.

## 12. Test invalid delays

Our API permits delays from 1,000 milliseconds to 86,400,000 milliseconds (24 hours).

**PowerShell — invalid delay test**

```powershell
$body = @{
  message = "Invalid delay test"
  delayMs = -500
} | ConvertTo-Json

try {
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri http://localhost:3000/demo/jobs/delayed `
    -ContentType "application/json" `
    -Body $body
}
catch {
  $_.Exception.Response.StatusCode
}
```

Expected status:

```text
400 Bad Request
```

Also test a delay that is too short:

**PowerShell — delay below the allowed minimum**

```powershell
$body = @{
  message = "Too short delay test"
  delayMs = 100
} | ConvertTo-Json

try {
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri http://localhost:3000/demo/jobs/delayed `
    -ContentType "application/json" `
    -Body $body
}
catch {
  $_.Exception.Response.StatusCode
}
```

Expected status:

```text
400 Bad Request
```

## 13. Test cancellation

First, schedule a job for 60 seconds in the future.

**PowerShell — create a job to cancel**

```powershell
$body = @{
  message = "Lecture 8 cancellation test"
  delayMs = 60000
} | ConvertTo-Json

$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs/delayed `
  -ContentType "application/json" `
  -Body $body

$result = $response.Content | ConvertFrom-Json
$cancelJobId = $result.data.jobId

$cancelJobId
```

Now cancel it.

**PowerShell — cancel the delayed job**

```powershell
Invoke-WebRequest `
  -UseBasicParsing `
  -Method DELETE `
  -Uri "http://localhost:3000/demo/jobs/$cancelJobId"
```

Expected response:

```json
{
  "success": true,
  "data": {
    "jobId": "YOUR_JOB_ID",
    "cancelled": true
  }
}
```

Inspect the job again.

**PowerShell — verify removal**

```powershell
try {
  Invoke-WebRequest `
    -UseBasicParsing `
    "http://localhost:3000/demo/jobs/$cancelJobId"
}
catch {
  $_.Exception.Response.StatusCode
}
```

Expected:

```text
404 Not Found
```

BullMQ has removed the job from the queue, so the status endpoint no longer finds it.

## 14. Intentional break test

Now we verify why the delay must be configured in the producer options.

File: `src/queues/producers/demo.producer.ts`

Temporarily replace:

```typescript
delayMs > 0
  ? { delay: delayMs }
  : {}
```

with:

```typescript
{}
```

This intentionally removes the delay configuration.

Build:

**PowerShell — compile the broken implementation**

```powershell
npm run build
```

Schedule a new job with a 5-second delay.

**PowerShell — submit the test**

```powershell
$body = @{
  message = "Intentional missing delay test"
  delayMs = 5000
} | ConvertTo-Json

$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs/delayed `
  -ContentType "application/json" `
  -Body $body

$response.Content
```

Inspect the job immediately. You should observe that it does not remain delayed as expected and may already be active or completed.

### Why did this happen?

The API accepted `delayMs`, but the producer never passed it to BullMQ. Validation alone cannot schedule a job.

The full chain must be correct:

```text
HTTP request
    ↓
validate delayMs
    ↓
pass delayMs to producer
    ↓
producer passes { delay: delayMs }
    ↓
BullMQ stores delayed job
```

Restore the correct code.

File: `src/queues/producers/demo.producer.ts`

```typescript
delayMs > 0
  ? { delay: delayMs }
  : {}
```

Rebuild and repeat the test. Confirm the job is delayed before its execution time.

## 15. Production patterns and success criteria

For our incident platform, delayed jobs can support several deterministic workflows.

| Use case | Example delay | Action |
|---|---|---|
| Incident acknowledgment reminder | 2 minutes | Notify the responsible team |
| Escalation | 10 minutes | Raise incident severity or notify the next on-call group |
| Remediation verification | 30 seconds | Check whether the incident has recovered |
| Temporary suppression expiry | 15 minutes | Re-evaluate an incident after suppression ends |

These are examples, not automatic behavior in our current demo.

### Critical production rules

1. Do not depend on an HTTP timer. Persist scheduled work in the queue.
2. Make job handlers idempotent. A job can execute more than once after retries or failures.
3. Re-check business state before acting. An escalation job should not escalate an incident that has already been resolved.
4. Treat cancellation carefully. A queued job being removed does not undo work already started.
5. Monitor delayed-job volume and age. A growing backlog can indicate worker or dependency problems.
6. Do not equate scheduling with exact-time execution. Queue delays are eligibility times, not real-time guarantees.

For example, before escalating an incident, the worker should read the incident from PostgreSQL and check whether it remains open and unacknowledged. This prevents an outdated scheduled job from acting on a resolved incident.

### Success criteria

By the end of this lecture, you should be able to:

-  Explain the difference between delayed jobs, retry backoff, and recurring jobs.
-  Schedule a job with BullMQ's `delay` option.
-  Validate a delay at the API and producer boundaries.
-  Inspect a job's state, attempts, timestamps, and result.
-  Remove a job that is still delayed.
-  Explain why an accepted delay value does not work unless the producer passes it to BullMQ.
-  Describe production safeguards such as idempotency, state re-checks, monitoring, and race-aware cancellation.
