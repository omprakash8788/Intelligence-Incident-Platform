# Lecture 9 — BullMQ Job Priorities & Queue Scheduling

Goal: Build a priority-based job-processing system where critical incident jobs are processed ahead of routine jobs, then test how priorities interact with worker concurrency, delayed jobs, and FIFO ordering.

Stack: Node.js · TypeScript · Express · Redis · BullMQ

Learning workflow: Build → Test → Break intentionally → Understand → Fix → Verify

## Table of contents

1. What job priorities solve
2. Understand BullMQ priority ordering
3. Understand the FIFO interaction
4. Update the job types
5. Update the producer
6. Update the API
7. Update the worker
8. Build and verify
9. Test priority ordering
10. Break and fix
11. Production design
12. Success criteria

## 1. What job priorities solve

Imagine our incident platform receives these jobs:

| Job                    | Priority | Business importance |
| ---------------------- | -------- | ------------------- |
| Critical incident      | 1        | Highest             |
| High-severity incident | 2        | High                |
| Normal incident        | 5        | Standard            |
| Background report      | 10       | Low                 |

Without priority handling, jobs generally follow queue ordering rules. A routine job already waiting in the queue could delay a critical incident.

With priorities, we can tell BullMQ which eligible jobs deserve preference.

Critical incident — priority 1

Highest priority

High-severity incident — priority 2

Normal work — priority 5

Background report — priority 10

One important distinction: priority affects which eligible job is picked next; it does not preempt a job that a worker is already processing.

## 2. Understand BullMQ priority ordering

BullMQ's numeric priority convention is easy to misunderstand.

- A lower positive number means a higher priority.
- Priority `1` is higher than priority `5`.
- Priority `10` is lower than priority `5`.
- Jobs without an explicit priority are handled through BullMQ's default-priority behavior; do not assume they have the same ordering as priority `1`.

We will assign an explicit priority to every job in this lecture.

| Priority | Meaning  |
| -------- | -------- |
| `1`      | Critical |
| `2`      | High     |
| `5`      | Normal   |
| `10`     | Low      |

BullMQ priorities apply when selecting among waiting, eligible jobs. A job still in the delayed state cannot be processed before its delay expires merely because it has a high priority.

### Priority is not preemption

Suppose a worker is already processing a 30-second report.

A critical job arrives five seconds later.

The critical job does not interrupt the report. It can be selected when a worker becomes available.

For this reason, priorities and concurrency must be designed together.

## 3. Understand FIFO ordering within priorities

For jobs with the same priority, insertion order is relevant to their processing order under normal queue conditions. However, concurrency, retries, delayed jobs, and worker availability can affect the observed completion order.

We will test the basic behavior using one worker and short, predictable jobs.

Our test:

```
Enqueue order:
  Normal A — priority 5
  Low A    — priority 10
  Critical — priority 1
  Normal B — priority 5

Expected selection order, if all are waiting before the worker can pick:
  Critical
  Normal A
  Normal B
  Low A
```

For a deterministic test, we must make sure all jobs are enqueued before the worker starts processing them. Otherwise, a job may become active before a higher-priority job arrives.

## 4. Update the job types

We will introduce a `priority` field in the job payload for observability. The actual scheduling priority will also be passed through BullMQ's job options.

Replace `src/queues/jobs/demo.job.ts` with:

```
export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable"
  | "delayed";

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
```

Every existing producer call must now supply `priority`. We will update the producer so callers do not have to duplicate this field manually.

## 5. Update the producer

We will make priority an explicit producer option and use `5` as the default.

Replace `src/queues/producers/demo.producer.ts` with:

```
import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData,
  DemoJobPriority
} from "../jobs/demo.job.js";

export interface AddDemoJobOptions {
  delayMs?: number;
  priority?: DemoJobPriority;
}

const isValidDelay = (
  delayMs: number
): boolean => {
  return (
    Number.isInteger(delayMs) &&
    delayMs >= 0 &&
    delayMs <= 86_400_000
  );
};

export const addDemoJob = async (
  data: Omit<DemoJobData, "priority">,
  options: AddDemoJobOptions = {}
): Promise<string> => {
  const delayMs =
    options.delayMs ?? 0;

  const priority =
    options.priority ?? 5;

  if (!isValidDelay(delayMs)) {
    throw new Error(
      "delayMs must be an integer between 0 and 86400000"
    );
  }

  const job = await demoQueue.add(
    "demo-job",
    {
      ...data,
      priority
    },
    {
      priority,
      ...(delayMs > 0
        ? { delay: delayMs }
        : {})
    }
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return job.id;
};
```

### Why set priority in two places?

The payload field is useful for logs and debugging. BullMQ's `priority` job option controls the actual queue scheduling.

The payload alone does not change queue ordering.

## 6. Update the API

We will support an optional priority when creating normal and delayed jobs.

Allowed values:

```
1, 2, 5, 10
```

If the client does not provide a priority, the producer defaults to `5`.

Replace `src/routes/demo-queue.routes.ts` with:

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

import {
  demoQueue
} from "../queues/demo.queue.js";

import type {
  DemoJobMode,
  DemoJobPriority
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

const isDemoJobPriority = (
  value: unknown
): value is DemoJobPriority => {
  return (
    value === 1 ||
    value === 2 ||
    value === 5 ||
    value === 10
  );
};

const parsePriority = (
  value: unknown
): DemoJobPriority | null => {
  if (value === undefined) {
    return 5;
  }

  if (isDemoJobPriority(value)) {
    return value;
  }

  return null;
};

router.post(
  "/demo/jobs",
  async (req, res, next) => {
    try {
      const {
        message,
        mode,
        priority
      } = req.body as {
        message?: unknown;
        mode?: unknown;
        priority?: unknown;
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

      const parsedPriority =
        parsePriority(priority);

      if (parsedPriority === null) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_PRIORITY",
            message:
              "priority must be 1, 2, 5, or 10"
          }
        });
        return;
      }

      const jobId = await addDemoJob(
        {
          message: message.trim(),
          mode
        },
        {
          priority: parsedPriority
        }
      );

      res.status(202).json({
        success: true,
        data: {
          jobId,
          priority: parsedPriority
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
        delayMs,
        priority
      } = req.body as {
        message?: unknown;
        delayMs?: unknown;
        priority?: unknown;
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

      const parsedPriority =
        parsePriority(priority);

      if (parsedPriority === null) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_PRIORITY",
            message:
              "priority must be 1, 2, 5, or 10"
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
          delayMs,
          priority: parsedPriority
        }
      );

      res.status(202).json({
        success: true,
        data: {
          jobId,
          state: "scheduled",
          delayMs,
          priority: parsedPriority
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
              "Only delayed jobs can be removed by this endpoint"
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

This retains the delayed-job and cancellation endpoints from Lecture 8 while adding priority support.

## 7.1 Update the worker

The worker does not need a new priority algorithm. BullMQ handles priority selection. We only need to log the configured priority.

File: `src/workers/demo.worker.ts`

Inside the existing job processor, after obtaining the job attempt number, add:

```
console.log(
  `[DemoWorker] Priority: ${job.opts.priority ?? "default"}`
);
```

If you want to log the business priority stored in the payload instead, use:

```
console.log(
  `[DemoWorker] Business priority: ${job.data.priority}`
);
```

Keep all existing error classification, retry, delay-mode, and `UnrecoverableError` logic unchanged.

Important: The worker's TypeScript generic must continue to use the updated `DemoJobData` type so `job.data.priority` is correctly typed.

## 8. Build and run

From the project root:

Command

```
npm run build
```

Expected: TypeScript compiles without errors.

Start the API:

Terminal 1

```
npm run dev
```

Start the worker:

Terminal 2

```
npm run dev:worker
```

If using Docker, rebuild the API and worker images only if your Compose configuration builds separate images for them. Verify which processes are actually running before testing.

## 9. Test priority ordering

A priority test is only meaningful if multiple jobs are waiting before the worker selects them. To make the experiment more reliable, stop the worker first.

### Step 1 — Stop the worker

Press `Ctrl+C` in the worker terminal.

Ensure no other worker process is consuming the same `demo-job` queue.

### Step 2 — Enqueue four jobs

We will submit jobs in this order:

1. Normal A — priority 5
2. Low A — priority 10
3. Critical — priority 1
4. Normal B — priority 5

PowerShell — enqueue jobs

```
function Add-DemoPriorityJob {
  param(
    [string]$Message,
    [int]$Priority
  )

  $body = @{
    message = $Message
    mode = "success"
    priority = $Priority
  } | ConvertTo-Json

  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri http://localhost:3000/demo/jobs `
    -ContentType "application/json" `
    -Body $body

  $response.Content | ConvertFrom-Json
}

$normalA = Add-DemoPriorityJob `
  -Message "Priority test - Normal A" `
  -Priority 5

$lowA = Add-DemoPriorityJob `
  -Message "Priority test - Low A" `
  -Priority 10

$critical = Add-DemoPriorityJob `
  -Message "Priority test - Critical" `
  -Priority 1

$normalB = Add-DemoPriorityJob `
  -Message "Priority test - Normal B" `
  -Priority 5

$normalA
$lowA
$critical
$normalB
```

Save the job IDs if you need to inspect each job later.

### Step 3 — Restart the worker

Terminal 2

```
npm run dev:worker
```

Observe the worker logs.

Expected selection order under this controlled setup:

```
Priority test - Critical
Priority test - Normal A
Priority test - Normal B
Priority test - Low A
```

The two priority-5 jobs should retain their relative enqueue order in this basic experiment.

### Why might the order differ?

Check for:

- Another worker process consuming jobs.
- Earlier waiting jobs left in Redis.
- Jobs that were enqueued before the four test jobs.
- Retries from older jobs.
- A job becoming active before the rest were enqueued.

Do not conclude that priorities are broken until these conditions are ruled out.

## 10. Test invalid priorities

Our API supports only `1`, `2`, `5`, and `10`.

PowerShell — submit an invalid priority

```
$body = @{
  message = "Invalid priority test"
  mode = "success"
  priority = 0
} | ConvertTo-Json

try {
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri http://localhost:3000/demo/jobs `
    -ContentType "application/json" `
    -Body $body
}
catch {
  $_.Exception.Response.StatusCode
}
```

Expected:

```
400 Bad Request
```

Also test a string:

PowerShell — string priority

```
$body = @{
  message = "String priority test"
  mode = "success"
  priority = "1"
} | ConvertTo-Json

try {
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri http://localhost:3000/demo/jobs `
    -ContentType "application/json" `
    -Body $body
}
catch {
  $_.Exception.Response.StatusCode
}
```

Expected: `400 Bad Request`. The API deliberately requires a JSON number, not a string.

## 11. Break and fix

We now test the difference between payload metadata and actual BullMQ scheduling.

### Break it

File: `src/queues/producers/demo.producer.ts`

Temporarily remove `priority` from the BullMQ options.

Change:

```
{
  priority,
  ...(delayMs > 0
    ? { delay: delayMs }
    : {})
}
```

to:

```
{
  ...(delayMs > 0
    ? { delay: delayMs }
    : {})
}
```

Now the payload still contains `priority`, but BullMQ no longer receives the scheduling option.

### Test it

1. Stop the worker.
2. Enqueue jobs at priorities `5`, `10`, `1`, and `5`.
3. Restart the worker.
4. Observe that priority-based selection is no longer guaranteed.

Other queue-ordering rules will govern these jobs.

### Fix it

Restore the `priority` property:

File: `src/queues/producers/demo.producer.ts`

```
{
  priority,
  ...(delayMs > 0
    ? { delay: delayMs }
    : {})
}
```

Rebuild:

Command

```
npm run build
```

Repeat the controlled ordering experiment. Verify that the critical job is selected before the lower-priority jobs when they are all waiting and eligible.

## 12. Production design: priority is not fairness

Priorities introduce a new risk: starvation.

Imagine critical jobs arrive continuously.

```
Critical jobs:  █ █ █ █ █ █ █ █ █
Normal jobs:    ─ ─ ─ ─ ─ ─ ─ ─ ─
Low jobs:       ─ ─ ─ ─ ─ ─ ─ ─ ─
```

If higher-priority work never stops arriving, normal and low-priority jobs may wait a very long time.

In a production incident platform, consider:

- Separate queues for different workload classes.
- Dedicated workers for critical jobs.
- Concurrency limits.
- Queue-age and backlog monitoring.
- Fairness policies for routine work.
- Explicit escalation deadlines.
- Idempotent processing so retries cannot duplicate side effects.

For example, you could dedicate a worker pool to critical incident detection while another pool handles reports. This can be more predictable than placing every workload in one queue and relying entirely on numeric priority.

### Priority and delayed jobs

A high-priority delayed job remains delayed until it becomes eligible. Once eligible, its priority can influence selection relative to other waiting jobs.

### Priority and retries

A retrying job is not necessarily the next job to execute. Other eligible jobs with higher priority can be selected first. Your system must not assume that a retry immediately follows its previous attempt.
