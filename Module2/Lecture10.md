# Lecture 10 — BullMQ Job Progress Tracking & Progress APIs

Goal: Track long-running background jobs, report progress from a worker, expose progress through an Express API, and verify that clients can observe a job moving from `waiting` to `active` to `completed`.

Stack: Node.js, TypeScript, Express, Redis, BullMQ

Workflow: Build → Test → Break intentionally → Understand → Fix → Verify

## Table of contents

1. What job progress solves
2. Understand `job.updateProgress()`
3. Understand the architecture
4. Update the job types
5. Update the worker
6. Update the job status service
7. Add a progress endpoint
8. Build and run
9. Test progress tracking
10. Test failure behavior
11. Intentional break and fix
12. Production considerations
13. Success criteria

## 1. What job progress solves

Imagine our incident platform runs a background diagnostic that checks 100 servers.

Without progress tracking, the API might report only:

```
{
  "state": "active"
}
```

The client cannot tell whether the job has checked 1 server or 99 servers.

With progress tracking, we can report:

```
{
  "state": "active",
  "progress": {
    "completed": 40,
    "total": 100,
    "percentage": 40
  }
}
```

This is useful for:

- Incident diagnostics
- Bulk event processing
- Log analysis
- Report generation
- Data imports
- Multi-step remediation workflows

Our implementation will use a deterministic simulation. We will not add AI or external services.

## 2. Understand `job.updateProgress()`

BullMQ provides:

```
await job.updateProgress(50);
```

The progress value can be a number or a JSON-compatible object.

For our project, an object is more useful:

```
await job.updateProgress({
  completed: 5,
  total: 10,
  percentage: 50
});
```

The worker writes progress to BullMQ's job record in Redis. The API reads the stored progress and returns it to the client.

Important distinction:

- `state` tells us the job lifecycle state.
- `progress` tells us how much work has been reported.
- `result` contains the worker's return value after successful completion.

Progress is not automatically calculated by BullMQ. Your worker must report it.

## 3. Understand the architecture

1\. Client submits a job
```
POST /demo/jobs
```

2\. BullMQ stores the job
```
Redis
```

3\. Worker processes steps
```
Calls job.updateProgress()
```
4\. API reads the progress
```
GET /demo/jobs/:jobId/progress
```
5\. Client sees updated progress
```
Poll until completed or failed
```

We will keep the existing queue, producer, retry policies, priority support, and delayed-job behavior from earlier lectures.

## 4. Update the job types

We need a new mode that performs several steps slowly enough to observe progress.

Replace `src/queues/jobs/demo.job.ts` with:

```
export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable"
  | "delayed"
  | "progress";

export type DemoJobPriority =
  | 1
  | 2
  | 5
  | 10;

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
  priority: DemoJobPriority;
}

export interface DemoJobProgress {
  completed: number;
  total: number;
  percentage: number;
  currentStep: string;
}
```

The `progress` mode is for this lecture's demonstration. Existing modes remain available.

## 5. Update the worker

We will simulate a diagnostic with 10 steps, each taking 1 second.

The worker will report progress after each completed step.

Replace `src/workers/demo.worker.ts` with the following complete version, retaining the existing retry behavior and priority logging.

```
import {
  Worker,
  Job,
  UnrecoverableError
} from "bullmq";

import {
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import type {
  DemoJobData,
  DemoJobProgress
} from "../queues/jobs/demo.job.js";

import {
  RetryableJobError,
  NonRetryableJobError
} from "../errors/job.errors.js";

const sleep = (
  milliseconds: number
): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

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
        `[DemoWorker] Priority: ${job.opts.priority ?? "default"}`
      );

      console.log(
        `[DemoWorker] Message: ${job.data.message}`
      );

      if (
        job.data.mode === "non-retryable"
      ) {
        const error =
          new NonRetryableJobError(
            "Invalid job data. This error must not be retried."
          );

        throw new UnrecoverableError(
          error.message
        );
      }

      if (
        job.data.mode === "failure"
      ) {
        const error =
          new NonRetryableJobError(
            "Intentional permanent demo failure"
          );

        throw new UnrecoverableError(
          error.message
        );
      }

      if (
        job.data.mode === "retryable" &&
        job.attemptsMade < 2
      ) {
        throw new RetryableJobError(
          `Temporary failure on attempt ${attempt}`
        );
      }

      if (
        job.data.mode === "fail-twice" &&
        job.attemptsMade < 2
      ) {
        throw new RetryableJobError(
          `Intentional transient failure on attempt ${attempt}`
        );
      }

      if (
        job.data.mode === "slow"
      ) {
        await sleep(10_000);
      }

      if (
        job.data.mode === "progress"
      ) {
        const total = 10;

        for (
          let completed = 1;
          completed <= total;
          completed++
        ) {
          await sleep(1_000);

          const progress: DemoJobProgress = {
            completed,
            total,
            percentage:
              Math.round(
                (completed / total) * 100
              ),
            currentStep:
              `Diagnostic step ${completed} of ${total}`
          };

          await job.updateProgress(
            progress
          );

          console.log(
            `[DemoWorker] Job ${job.id}: ${progress.percentage}%`
          );
        }
      }

      return {
        processed: true,
        attempt
      };
    },

    {
      connection:
        createBullMQConnection(null)
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
        errorType: error.name,
        message: error.message,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts.attempts
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

### What happens here?

For a progress job, the worker reports:

```
10% → 20% → 30% → ... → 100%
```

The progress update is stored in Redis.

Note: `100%` means the worker completed its reported steps. The job may still need a short amount of time to return its result and transition to `completed`.

## 6. Update the job status service

We need to expose the job's progress through the API.

Replace `src/services/demo-job.service.ts` with:

```
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
  progress: number | object;
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
      progress: job.progress,
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

The `progress` property can be a number or an object, matching BullMQ's API.

## 7. Add a dedicated progress endpoint

We already have a status endpoint:

`GET /demo/jobs/:jobId`

We will add a dedicated endpoint for progress so clients do not need to interpret the full job status response.

File: `src/routes/demo-queue.routes.ts`

Add this route before the general `GET /demo/jobs/:jobId` route.

```
router.get(
  "/demo/jobs/:jobId/progress",
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
        data: {
          jobId: job.id,
          state: job.state,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
```

Why put this route before the general status route? Express normally matches the more specific path correctly, but placing specific routes first makes the routing intent easier to read and maintain.

### Confirm job mode validation

The `POST /demo/jobs` route must accept `"progress"`.

In `src/routes/demo-queue.routes.ts`, ensure your `isDemoJobMode` function contains:

```
value === "progress"
```

If not, add it to the existing `return` expression.

### Confirm the producer

The producer from Lecture 9 accepts:

```
Omit<DemoJobData, "priority">
```

That means it will continue to work with the new `progress` mode without requiring a new producer function.

## 8. Build and run

From the project root:

PowerShell — compile TypeScript

```
npm run build
```

Expected: no TypeScript errors.

Start the API.

Terminal 1

```
npm run dev
```

Start the worker.

Terminal 2

```
npm run dev:worker
```

If the build fails, fix the reported file and line before running the tests.

## 9. Test progress tracking

### Step 1 — Submit a progress job

PowerShell — create the job

```
$body = @{
  message = "Lecture 10 progress tracking test"
  mode = "progress"
  priority = 5
} | ConvertTo-Json

$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs `
  -ContentType "application/json" `
  -Body $body

$response.Content
```

Expected response shape:

```
{
  "success": true,
  "data": {
    "jobId": "YOUR_JOB_ID",
    "priority": 5
  }
}
```

### Step 2 — Save the job ID

PowerShell

```
$result = $response.Content | ConvertFrom-Json
$jobId = $result.data.jobId

$jobId
```

### Step 3 — Query progress repeatedly

PowerShell — poll progress

```
for ($i = 0; $i -lt 12; $i++) {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      "http://localhost:3000/demo/jobs/$jobId/progress"

    $result = $response.Content | ConvertFrom-Json

    $result.data | ConvertTo-Json -Depth 5

    if (
      $result.data.state -eq "completed" -or
      $result.data.state -eq "failed"
    ) {
      break
    }
  }
  catch {
    Write-Host $_
  }

  Start-Sleep -Seconds 1
}
```

Expected progress objects will look similar to:

```
{
  "success": true,
  "data": {
    "jobId": "YOUR_JOB_ID",
    "state": "active",
    "progress": {
      "completed": 4,
      "total": 10,
      "percentage": 40,
      "currentStep": "Diagnostic step 4 of 10"
    },
    "attemptsMade": 0,
    "failedReason": ""
  }
}
```

The exact step will vary depending on when you make the request.

The eventual response should show:

```
{
  "state": "completed",
  "progress": {
    "completed": 10,
    "total": 10,
    "percentage": 100,
    "currentStep": "Diagnostic step 10 of 10"
  }
}
```

### Step 4 — Inspect the worker logs

Expected log pattern:

```
[DemoWorker] Job ...: 10%
[DemoWorker] Job ...: 20%
[DemoWorker] Job ...: 30%
...
[DemoWorker] Job ...: 100%
[DemoWorker] Job ... completed
```

Do not expect every polling request to observe every percentage. The worker updates once per second, and HTTP polling has its own timing.

## 10. Test the normal status endpoint

The dedicated progress endpoint is useful, but the original endpoint must also expose progress.

PowerShell — inspect complete status

```
Invoke-WebRequest `
  -UseBasicParsing `
  "http://localhost:3000/demo/jobs/$jobId"
```

Confirm that the response includes:

- `state`
- `progress`
- `attemptsMade`
- `attemptsAllowed`
- `result`

After completion, the result should look similar to:

```
{
  "processed": true,
  "attempt": 1
}
```

Progress and result serve different purposes. Progress describes intermediate work; the result describes the outcome returned by the processor.

## 11. Test failure behavior

Progress tracking must not hide failures.

Our existing `"failure"` mode throws a non-retryable error.

PowerShell — submit a failure job

```
$body = @{
  message = "Lecture 10 failure test"
  mode = "failure"
  priority = 5
} | ConvertTo-Json

$response = Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  -Uri http://localhost:3000/demo/jobs `
  -ContentType "application/json" `
  -Body $body

$result = $response.Content | ConvertFrom-Json
$failedJobId = $result.data.jobId

$failedJobId
```

Inspect its progress and state.

PowerShell

```
Invoke-WebRequest `
  -UseBasicParsing `
  "http://localhost:3000/demo/jobs/$failedJobId/progress"
```

Expected:

```
{
  "success": true,
  "data": {
    "jobId": "YOUR_JOB_ID",
    "state": "failed",
    "progress": 0
  }
}
```

Because this job fails before reporting any progress, the stored progress will generally remain at its initial value.

## 12. Intentional break and fix

Now we will prove that progress depends on the worker reporting it.

### Break it

File: `src/workers/demo.worker.ts`

Temporarily comment out the update:

```
// await job.updateProgress(progress);
```

Leave the loop and logs in place.

Rebuild:

PowerShell

```
npm run build
```

Submit another progress job and poll it.

You will see the worker logs advancing, but the API will not show the corresponding stored progress updates.

Why?

```
Worker calculates progress
        |
        v
Worker logs progress
        |
        X
Does not write progress to BullMQ
        |
        v
API sees stale progress
```

Logging a value does not persist it.

### Fix it

Restore:

File: `src/workers/demo.worker.ts`

```
await job.updateProgress(progress);
```

Rebuild:

PowerShell

```
npm run build
```

Submit a new progress job. Poll the API and confirm that the percentage increases.

## 13. Production considerations

### 13.1 Do not report progress too frequently

Updating progress every few milliseconds creates unnecessary Redis operations.

Prefer meaningful milestones:

- Every batch of records
- Every completed diagnostic step
- Every file processed
- Every phase transition

### 13.2 Progress is not a transaction

A job may update progress and then fail. The progress value can reflect work completed before the failure, not necessarily the total amount of business work durably committed.

For business-critical workflows, track durable outcomes in PostgreSQL separately.

### 13.3 Retries can reset or repeat progress

If a job fails after reaching 60% and BullMQ retries it, the next execution may begin the work again. Our current example updates progress from 10% on each attempt.

A production handler should define whether progress is:

- Per attempt
- Across the entire job
- Based on durable completed records

Do not assume retries automatically resume at the exact previous step.

### 13.4 Progress polling versus events

Polling is simple, but frequent polling creates HTTP and Redis traffic. Later, our project can use the existing WebSocket architecture to push progress updates to connected clients.

We will keep this lecture focused on the API-based approach.