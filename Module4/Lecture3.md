# Phase 5 — Observability Engine
## Lecture 3: Worker Job Duration, Throughput, and Retry Metrics

**Project:** Production Intelligence & Incident Platform  
**Stack:** Node.js, TypeScript, BullMQ, Redis, Express  
**Design:** Deterministic metrics and rules. No AI, RAG, or agents.
**Design:** Deterministic metrics and rules. No AI, RAG, or agents.

---

## 1. What we are building

Our worker metrics currently track how many jobs started, completed, and failed. Those counters alone cannot tell us whether processing is getting slower.

Consider two workers:

| Metric | Worker A | Worker B |
|---|---:|---:|
| Jobs completed | 100 | 100 |
| Average job duration | 200 ms | 5,000 ms |
| Completed jobs per minute | 100 | 12 |
| Interpretation | Faster processing | Potentially unhealthy |

Both workers completed the same number of jobs, but their performance is very different.

In this lecture, we'll measure:

- **Job duration:** how long each processor execution takes.
- **Throughput:** how many jobs complete during a defined time window.
- **Retry attempts:** how often a job has been retried.
- **Terminal failures:** jobs that ultimately fail after exhausting their retries.
- **Active work:** jobs currently being processed.

## 2. Understand the mathematics

### Job duration

For one job:

\[
\text{durationMs}=\text{finishTime}-\text{startTime}
\]

Use a monotonic clock such as `performance.now()` for elapsed time. Wall-clock time such as `Date.now()` can jump if the system clock changes.

### Average duration

\[
\text{averageDurationMs}=
\frac{\text{totalDurationMs}}{\text{completedJobs}}
\]

For example, if three jobs take 100 ms, 200 ms, and 300 ms:

\[
\frac{100+200+300}{3}=200\text{ ms}
\]

Average duration is useful, but it can hide slow outliers. We'll add percentile-based measurements in a later lecture.

### Throughput

\[
\text{throughput}=
\frac{\text{completed jobs during a window}}
{\text{window duration in seconds}}
\]

If 120 jobs complete during 60 seconds:

\[
\frac{120}{60}=2\text{ jobs/second}
\]

Throughput is not the same as concurrency. Five jobs may run concurrently while the system completes fewer than five jobs per second.

### Retry rate

For a chosen window:

\[
\text{retry rate}=
\frac{\text{retry attempts}}{\text{job processing attempts}}
\times100
\]

We must define what counts as an attempt and ensure the numerator and denominator cover the same window. Otherwise, the rate can be misleading.

---

## 3. Inspect the current implementation

The repository already has these files:

- `production-intelligence-platform/src/services/worker-metrics.service.ts`
- `production-intelligence-platform/src/workers/external-api.worker.ts`
- `production-intelligence-platform/src/queues/external-api.queue.ts`
- `production-intelligence-platform/src/routes/external-api.routes.ts`

The external API queue uses three configured attempts and exponential backoff. The worker uses concurrency 5 and a rate limiter.

Before editing, run the baseline.

**Path:** `production-intelligence-platform/`

```powershell
npm run build
npm run test:run
```

Save any existing errors so we can distinguish baseline failures from new failures.

---

## 4. Create a duration and throughput metrics service

We'll keep this service independent of BullMQ. The worker will report lifecycle events to it, and the service will maintain in-memory counters.

For this first implementation, throughput is calculated from completions observed during a rolling 60-second window. Old completion timestamps are removed as new observations arrive.

**Create file:** `production-intelligence-platform/src/services/worker-performance-metrics.service.ts`

```typescript
import { performance } from "node:perf_hooks";

export interface WorkerPerformanceSnapshot {
  worker: string;
  startedTotal: number;
  completedTotal: number;
  failedTotal: number;
  retryAttemptsTotal: number;
  activeJobs: number;
  totalDurationMs: number;
  averageDurationMs: number;
  completionsLastMinute: number;
  throughputJobsPerSecond: number;
  sampledAt: string;
}

interface CompletionSample {
  at: number;
  durationMs: number;
}

class WorkerPerformanceMetricsService {
  private startedTotal = 0;
  private completedTotal = 0;
  private failedTotal = 0;
  private retryAttemptsTotal = 0;
  private activeJobs = 0;
  private totalDurationMs = 0;

  private readonly startTimes = new Map<string, number>();
  private readonly completionSamples: CompletionSample[] = [];

  private readonly windowMs = 60_000;

  jobStarted(jobId: string): void {
    this.startedTotal += 1;
    this.activeJobs += 1;

    this.startTimes.set(
      jobId,
      performance.now()
    );
  }

  jobCompleted(jobId: string): void {
    const startTime = this.startTimes.get(jobId);

    if (startTime !== undefined) {
      const durationMs = Math.max(
        0,
        performance.now() - startTime
      );

      this.totalDurationMs += durationMs;

      this.completionSamples.push({
        at: Date.now(),
        durationMs
      });

      this.startTimes.delete(jobId);
    }

    this.completedTotal += 1;
    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );

    this.pruneCompletionSamples();
  }

  jobFailed(jobId: string): void {
    this.failedTotal += 1;
    this.startTimes.delete(jobId);

    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );

    this.pruneCompletionSamples();
  }

  jobRetried(): void {
    this.retryAttemptsTotal += 1;
  }

  snapshot(): WorkerPerformanceSnapshot {
    this.pruneCompletionSamples();

    const completionsLastMinute =
      this.completionSamples.length;

    const averageDurationMs =
      this.completedTotal === 0
        ? 0
        : this.totalDurationMs / this.completedTotal;

    return {
      worker: "external-api",
      startedTotal: this.startedTotal,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
      retryAttemptsTotal: this.retryAttemptsTotal,
      activeJobs: this.activeJobs,
      totalDurationMs: this.totalDurationMs,
      averageDurationMs,
      completionsLastMinute,
      throughputJobsPerSecond:
        completionsLastMinute / (this.windowMs / 1000),
      sampledAt: new Date().toISOString()
    };
  }

  resetForTests(): void {
    this.startedTotal = 0;
    this.completedTotal = 0;
    this.failedTotal = 0;
    this.retryAttemptsTotal = 0;
    this.activeJobs = 0;
    this.totalDurationMs = 0;
    this.startTimes.clear();
    this.completionSamples.length = 0;
  }

  private pruneCompletionSamples(): void {
    const cutoff = Date.now() - this.windowMs;

    while (
      this.completionSamples.length > 0 &&
      this.completionSamples[0]!.at < cutoff
    ) {
      this.completionSamples.shift();
    }
  }
}

export const workerPerformanceMetrics =
  new WorkerPerformanceMetricsService();
```

### Important design notes

1. `performance.now()` measures elapsed time without relying on wall-clock changes.
2. The completion window uses `Date.now()` to compare sample timestamps with the current wall clock.
3. `startedTotal` counts processor executions, not unique job IDs. A retry can start another execution.
4. The rolling window stores completion samples in memory. This is suitable for a learning implementation but not ideal for a very high-volume worker.
5. The service currently measures the processor execution from the observed start event until completion or failure. It does not measure time spent waiting in the queue.

**Throughput definition:** this implementation reports the number of observed completions in the last minute divided by 60 seconds. It is a rolling-window rate, not an exact rate for every possible window length.

---

## 5. Instrument the worker

We need to send job lifecycle events to the new service.

**Modify file:** `production-intelligence-platform/src/workers/external-api.worker.ts`

### Step 5.1 — Add the import

```typescript
import {
  workerPerformanceMetrics
} from "../services/worker-performance-metrics.service.js";
```

### Step 5.2 — Replace the processor callback

Replace the existing processor callback inside `new Worker(...)` with this version. Preserve the existing worker constructor options, concurrency, and rate limiter.

```typescript
async (job) => {
  const jobId = String(job.id);

  workerPerformanceMetrics.jobStarted(jobId);

  logger.info(
    "External API job started",
    {
      queue: EXTERNAL_API_QUEUE_NAME,
      jobId,
      requestId: job.data.requestId
    }
  );

  try {
    const result =
      await simulateExternalApiRequest(
        job.data
      );

    workerPerformanceMetrics.jobCompleted(jobId);

    logger.info(
      "External API job completed",
      {
        queue: EXTERNAL_API_QUEUE_NAME,
        jobId,
        requestId: result.requestId,
        processedAt: result.processedAt
      }
    );

    return result;
  } catch (error) {
    workerPerformanceMetrics.jobFailed(jobId);
    throw error;
  }
},
```

### Why rethrow the error?

BullMQ must receive the processor failure to apply its retry policy. If we catch an error and return normally, BullMQ may treat the job as successfully completed.

### Important lifecycle limitation

This implementation tracks the processor's execution duration. It does not fully solve all lifecycle accounting for stalled jobs or process crashes. Also, the job ID is used as the start-time map key. In unusual overlapping or stalled-job recovery scenarios, that can be insufficient to distinguish separate executions of the same job.

We will revisit robust execution identity and worker lifecycle handling as the observability design matures.

---

## 6. Count retry attempts correctly

A final `failed` event is not the same thing as a failed attempt. With retries enabled, a job can fail an attempt and then succeed later.

BullMQ exposes a `retrying` event on supported versions of its worker event API. Confirm the event type against the BullMQ version installed in this repository before relying on it.

For the standard worker lifecycle, the `"failed"` handler is emitted for failed processing attempts; the job's `attemptsMade` and configured `attempts` help distinguish an intermediate retry from a terminal failure.

**Modify file:** `production-intelligence-platform/src/workers/external-api.worker.ts`

Replace the existing `"failed"` handler with:

```typescript
externalApiWorker.on(
  "failed",
  (job, error) => {
    if (job && job.attemptsMade < job.opts.attempts!) {
      workerPerformanceMetrics.jobRetried();
    }

    logger.error(
      "External API job failed",
      {
        queue: EXTERNAL_API_QUEUE_NAME,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        configuredAttempts: job?.opts.attempts,
        error: error.message
      }
    );
  }
);
```

### Verify the attempt semantics

Before using this logic in production, check how your installed BullMQ version updates `attemptsMade` when the worker emits the failed event. Also avoid relying on the non-null assertion `!` if `attempts` is optional in your queue configuration.

A safer explicit comparison is:

```typescript
const configuredAttempts =
  job?.opts.attempts ?? 1;

const attemptsMade =
  job?.attemptsMade ?? 0;

const isRetryExpected =
  Boolean(job) &&
  attemptsMade < configuredAttempts;
```

Use the actual BullMQ event behavior verified by your tests to decide when to increment retry metrics.

---

## 7. Expose the performance snapshot

The existing route is:

`GET /monitoring/queues/external-api`

We'll add a separate endpoint so the existing response contract stays unchanged.

**Modify file:** `production-intelligence-platform/src/routes/external-api.routes.ts`

Add this import:

```typescript
import {
  workerPerformanceMetrics
} from "../services/worker-performance-metrics.service.js";
```

Add this route before `export default router;`:

```typescript
router.get(
  "/monitoring/workers/external-api",
  (_req, res) => {
    res.status(200).json({
      success: true,
      data: workerPerformanceMetrics.snapshot()
    });
  }
);
```

This endpoint reports the current process-local snapshot. It is not a durable metrics store and should not be interpreted as an aggregated view across multiple worker instances.

---

## 8. Add unit tests

The tests should validate calculations and counters without needing Redis.

**Create file:** `production-intelligence-platform/tests/worker-performance-metrics.service.test.ts`

```typescript
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";

import {
  workerPerformanceMetrics
} from "../src/services/worker-performance-metrics.service.js";

describe("worker performance metrics", () => {
  afterEach(() => {
    workerPerformanceMetrics.resetForTests();
  });

  it("starts with zero counters", () => {
    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(metrics.startedTotal).toBe(0);
    expect(metrics.completedTotal).toBe(0);
    expect(metrics.failedTotal).toBe(0);
    expect(metrics.retryAttemptsTotal).toBe(0);
    expect(metrics.activeJobs).toBe(0);
    expect(metrics.averageDurationMs).toBe(0);
    expect(metrics.throughputJobsPerSecond).toBe(0);
  });

  it("tracks started and completed jobs", () => {
    workerPerformanceMetrics.jobStarted("job-1");
    workerPerformanceMetrics.jobCompleted("job-1");

    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(metrics.startedTotal).toBe(1);
    expect(metrics.completedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.averageDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks failed jobs", () => {
    workerPerformanceMetrics.jobStarted("job-2");
    workerPerformanceMetrics.jobFailed("job-2");

    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(metrics.failedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
  });

  it("tracks retry attempts", () => {
    workerPerformanceMetrics.jobRetried();
    workerPerformanceMetrics.jobRetried();

    expect(
      workerPerformanceMetrics.snapshot().retryAttemptsTotal
    ).toBe(2);
  });

  it("includes a valid timestamp", () => {
    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(
      Number.isNaN(Date.parse(metrics.sampledAt))
    ).toBe(false);
  });
});
```

These tests validate the basic counters and timing output. They do not guarantee a specific duration because execution time depends on scheduling and machine load.

---

## 9. Build and test

**Path:** `production-intelligence-platform/`

```powershell
npx vitest run tests/worker-performance-metrics.service.test.ts
npm run test:run
npm run build
```

Resolve all type errors instead of bypassing them with `any`. In particular, check BullMQ's event typings and the optional `attempts` configuration.

Do not mark the tests as passing until you have actually run them.

---

## 10. Runtime verification

Start the API and worker in separate terminals.

**Path:** `production-intelligence-platform/` — Terminal 1

```powershell
npm run dev
```

**Path:** `production-intelligence-platform/` — Terminal 2

```powershell
npm run dev:worker
```

Submit five jobs using the existing bulk producer route.

**Path:** PowerShell terminal

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/demo/external-api/jobs/bulk `
  -ContentType "application/json" `
  -Body '{"count":5}'
```

Then inspect worker metrics.

**Path:** PowerShell terminal

```powershell
Invoke-RestMethod `
  http://localhost:3000/monitoring/workers/external-api |
  ConvertTo-Json -Depth 5
```

Observe the values before and after the jobs complete.

Expected behavior:

- `startedTotal` increases when processor executions begin.
- `completedTotal` increases when jobs complete successfully.
- `activeJobs` returns to zero after all tracked executions finish.
- `totalDurationMs` increases as jobs complete.
- `averageDurationMs` represents the average duration of completed jobs.
- `completionsLastMinute` counts completions in the rolling window.
- `throughputJobsPerSecond` is the rolling completion count divided by 60.

Because the simulated task is short and the worker has concurrency 5, the jobs may complete before you inspect the metrics.

---

## 11. Intentional break → root cause → fix → retest

### Break A: Stop recording completion

Temporarily remove this call from the worker:

```typescript
workerPerformanceMetrics.jobCompleted(jobId);
```

Enqueue a job and inspect the metrics.

**Expected symptom:** the started count increases, but the completed count and completion duration do not update.

**Root cause:** the worker no longer reports successful completion to the metrics service.

**Fix:** restore the call and retest.

### Break B: Stop recording retries

Temporarily remove the call to `workerPerformanceMetrics.jobRetried()` from the failed-event handler.

Submit a job that is known to fail using a controlled test fixture, not a production dependency.

**Expected symptom:** retry logs may appear, but the retry metric does not increase.

**Root cause:** retry observations are not being recorded.

**Fix:** restore the call and confirm the configured retry behavior in a focused test.

---

## 12. Production caveats

This is a learning implementation. Before using these metrics for alerting or automated remediation, address the following:

1. **Process-local state:** metrics reset on worker restart.
2. **Multiple workers:** each worker process has a separate snapshot.
3. **Retries:** a failed attempt may not represent a terminal job failure.
4. **Duration distribution:** an average alone hides long-running outliers.
5. **Memory growth:** a rolling window should be implemented efficiently at high event volumes.
6. **Lifecycle correctness:** stalled jobs and worker crashes require additional handling.
7. **Throughput interpretation:** a rolling average can hide sudden drops in recent processing.
8. **No persistence:** the current metrics are not stored in PostgreSQL.

The goal is to establish the measurements correctly before adding alerts or remediation.

---

## 13. Completion checklist

- [ ] Added worker duration and throughput metrics.
- [ ] Instrumented job start, success, and failure.
- [ ] Added retry-attempt observations.
- [ ] Added `GET /monitoring/workers/external-api`.
- [ ] Added unit tests.
- [ ] Ran focused tests, the full test suite, and the TypeScript build.
- [ ] Enqueued jobs and verified the runtime metrics.
- [ ] Completed the intentional-break exercises and restored the implementation.

**Repository status:** this lecture describes the implementation to apply. It does not mean these changes have been committed or tested in your GitHub repository.

## Next lecture

**Phase 5 — Lecture 4: Metrics Windows, Percentiles, and Reliable Aggregation**

We will improve the rolling metrics, learn why p50/p95/p99 duration matters, and design an aggregation strategy that remains meaningful across worker restarts and multiple processes.
