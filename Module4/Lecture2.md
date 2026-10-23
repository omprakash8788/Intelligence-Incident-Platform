# Phase 5 — Observability Engine
## Lecture 2: Queue and Worker Metrics

**Project:** Production Intelligence & Incident Platform  
**Stack:** Node.js, TypeScript, Express, BullMQ, Redis  
**Approach:** Deterministic metrics and rules only — no AI, RAG, or agents.

---

## 1. Learning objectives

By the end of this lecture, you will be able to:

1. Collect queue counts from BullMQ.
2. Track worker jobs started, completed, failed, and currently active.
3. Calculate a queue's backlog and health status.
4. Expose queue and worker metrics through a monitoring endpoint.
5. Test metrics without depending on a running Redis server for every unit test.
6. Diagnose a queue that has waiting jobs but is not processing them.

### How the monitoring flow works

```text
BullMQ Queues ────────┐
                      ├──> Metrics Service ──> Monitoring API
BullMQ Worker Events ─┘
                              │
                              ▼
                     Health / Backlog Rules
```

Queue metrics describe the **state of jobs in BullMQ**. Worker metrics describe **what the worker process has observed**. Keep these separate because they answer different questions.

---

## 2. Inspect the existing implementation first

Repository root:

`production-intelligence-platform/`

The project already contains:

- `src/services/demo-queue-metrics.service.ts`
- `src/routes/queue-monitoring.routes.ts`
- `src/queues/demo.queue.ts`
- `src/queues/external-api.queue.ts`
- `src/workers/external-api.worker.ts`

The demo queue metrics service already calls `getJobCounts()`. We will preserve it and add a separate worker metrics service instead of creating a second queue-monitoring architecture.

**Do not replace `src/workers.ts`.** This lecture only instruments the existing external API worker.

Before changing files, run the baseline.

**Path:** `production-intelligence-platform/`  
**Terminal:**

```powershell
npm run build
npm run test:run
```

Record any pre-existing failures. Do not assume the baseline passes.

---

## 3. Understand the metrics

### Queue metrics

| Metric | Meaning |
|---|---|
| `waiting` | Jobs waiting to be processed |
| `active` | Jobs currently being processed |
| `delayed` | Jobs scheduled for later |
| `completed` | Completed jobs still retained by BullMQ |
| `failed` | Failed jobs still retained by BullMQ |
| `waitingChildren` | Jobs waiting for child-job dependencies |
| `backlog` | Number of waiting jobs |
| `health` | Rule-based queue status |

Important: BullMQ's completed and failed counts reflect jobs still retained in Redis. They are **not lifetime totals**. If completed jobs are removed, the count can decrease.

### Worker metrics

| Metric | Meaning |
|---|---|
| `startedTotal` | Jobs observed starting in this worker process |
| `completedTotal` | Jobs successfully processed by this worker process |
| `failedTotal` | Jobs observed failing through the worker's failed event |
| `activeJobs` | Jobs currently being processed by this worker process |

These are process-local metrics. They reset when the process restarts and are not automatically aggregated across multiple worker instances.

---

## 4. Create the worker metrics service

Create a small service that tracks lifecycle events. It does not import a worker or queue, which helps avoid circular dependencies.

**Create file:** `production-intelligence-platform/src/services/worker-metrics.service.ts`

```typescript
export interface WorkerMetricsSnapshot {
  worker: string;
  startedTotal: number;
  completedTotal: number;
  failedTotal: number;
  activeJobs: number;
  sampledAt: string;
}

class WorkerMetricsService {
  private startedTotal = 0;
  private completedTotal = 0;
  private failedTotal = 0;
  private activeJobs = 0;

  jobStarted(): void {
    this.startedTotal += 1;
    this.activeJobs += 1;
  }

  jobCompleted(): void {
    this.completedTotal += 1;
    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );
  }

  jobFailed(): void {
    this.failedTotal += 1;
    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );
  }

  snapshot(): WorkerMetricsSnapshot {
    return {
      worker: "external-api",
      startedTotal: this.startedTotal,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
      activeJobs: this.activeJobs,
      sampledAt: new Date().toISOString()
    };
  }

  resetForTests(): void {
    this.startedTotal = 0;
    this.completedTotal = 0;
    this.failedTotal = 0;
    this.activeJobs = 0;
  }
}

export const workerMetrics =
  new WorkerMetricsService();
```

### Why have a `resetForTests()` method?

Unit tests need a predictable starting state. Without a reset, one test could inherit counters from another.

This method is for tests only. Do not expose it as a public HTTP endpoint.

---

## 5. Instrument the existing external API worker

We will record the start and completion of each job, plus failures reported by the worker.

**Modify file:** `production-intelligence-platform/src/workers/external-api.worker.ts`

### Step 5.1 — Add the import

Add this import alongside the other service imports.

```typescript
import {
  workerMetrics
} from "../services/worker-metrics.service.js";
```

### Step 5.2 — Record job start

Inside the existing processor callback, add `workerMetrics.jobStarted()` before the existing start log.

Find this section:

```typescript
async (job) => {
  logger.info(
    "External API job started",
```

Replace that opening section with:

```typescript
async (job) => {
  workerMetrics.jobStarted();

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

  workerMetrics.jobCompleted();

  return result;
},
```

**Important:** This is the complete replacement for the existing processor callback, not an additional second processor. Keep the existing `Worker` constructor options after the callback unchanged.

### Step 5.3 — Track failed jobs

Find the existing `externalApiWorker.on("failed", ...)` handler. Replace that handler with:

```typescript
externalApiWorker.on(
  "failed",
  (job, error) => {
    workerMetrics.jobFailed();

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
```

Keep the existing worker `"error"` handler unchanged.

### Important limitation: retries

BullMQ can retry a job after a processor throws an error. A job that fails an attempt but is later retried may not emit a final `"failed"` event until it has exhausted its attempts.

Therefore, `failedTotal` here means **failed events observed by this worker**, not every failed attempt. We'll add retry-attempt metrics in a later lesson.

### A subtle lifecycle issue

If the processor throws an error before `jobCompleted()` executes, the active counter remains elevated until a failure event decrements it. This matches the current event-based design, but worker shutdown, stalled jobs, and unusual failure paths need careful testing before treating the counter as authoritative in a multi-worker production deployment.

---

## 6. Add a multi-queue metrics service

We already have a demo queue metrics service. Instead of replacing it, add a new service that reports counts for both existing queues.

**Create file:** `production-intelligence-platform/src/services/queue-observability.service.ts`

```typescript
import {
  demoQueue,
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

import {
  externalApiQueue,
  EXTERNAL_API_QUEUE_NAME
} from "../queues/external-api.queue.js";

import type {
  QueueHealth
} from "./demo-queue-metrics.service.js";

export interface QueueObservabilitySnapshot {
  queue: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    waitingChildren: number;
  };
  backlog: number;
  health: QueueHealth;
  thresholds: {
    maxWaiting: number;
  };
  sampledAt: string;
}

const MAX_WAITING_JOBS = 10;

const collectQueueMetrics = async (
  queueName: string,
  queue: typeof demoQueue
): Promise<QueueObservabilitySnapshot> => {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "completed",
    "failed",
    "waiting-children"
  );

  const normalizedCounts = {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    waitingChildren:
      counts["waiting-children"] ?? 0
  };

  const backlog = normalizedCounts.waiting;

  const health: QueueHealth =
    backlog > MAX_WAITING_JOBS
      ? "degraded"
      : "healthy";

  return {
    queue: queueName,
    counts: normalizedCounts,
    backlog,
    health,
    thresholds: {
      maxWaiting: MAX_WAITING_JOBS
    },
    sampledAt: new Date().toISOString()
  };
};

export const getQueueObservability = async () => {
  const queues = await Promise.all([
    collectQueueMetrics(
      DEMO_QUEUE_NAME,
      demoQueue
    ),
    collectQueueMetrics(
      EXTERNAL_API_QUEUE_NAME,
      externalApiQueue
    )
  ]);

  return {
    queues,
    sampledAt: new Date().toISOString()
  };
};
```

### Type compatibility check

The service uses `typeof demoQueue` for the queue parameter to keep the helper compact. If your installed BullMQ typings reject `externalApiQueue` because its job data and result types differ from the demo queue, do **not** cast the queue to `any`. Instead, change the helper to accept the common BullMQ queue interface supported by your installed version, or use two small typed collection functions. The build command in Section 9 will reveal whether this adjustment is needed.

The health threshold is deliberately simple for this lesson:

- `waiting` less than or equal to 10 → `healthy`
- `waiting` greater than 10 → `degraded`

This is an educational rule, not a universal production threshold.

---

## 7. Expose the metrics through the monitoring API

The existing `queue-monitoring.routes.ts` already serves:

- `GET /monitoring/metrics`
- `GET /monitoring/queues/demo`

Add a new endpoint without removing either existing route.

**Modify file:** `production-intelligence-platform/src/routes/queue-monitoring.routes.ts`

### Step 7.1 — Add imports

Add these imports alongside the existing imports:

```typescript
import {
  getQueueObservability
} from "../services/queue-observability.service.js";

import {
  workerMetrics
} from "../services/worker-metrics.service.js";
```

### Step 7.2 — Add the endpoint

Add the following route before `export default router;`.

```typescript
router.get(
  "/monitoring/queues",
  async (_req, res, next) => {
    try {
      const queueMetrics =
        await getQueueObservability();

      const worker =
        workerMetrics.snapshot();

      const degraded =
        queueMetrics.queues.some(
          (queue) =>
            queue.health === "degraded"
        );

      res.status(degraded ? 503 : 200).json({
        success: !degraded,
        data: {
          ...queueMetrics,
          workers: [worker]
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
```

This preserves the current route and adds a combined snapshot.

### Why return HTTP 503 when degraded?

For this lecture, the endpoint treats a queue exceeding its backlog threshold as degraded and returns `503 Service Unavailable`.

This is a simple operational contract, but remember that a metrics endpoint and a readiness endpoint have different responsibilities. A growing queue does not necessarily mean the API itself cannot accept requests. Later, we will decide which conditions should create incidents and which should affect readiness.

---

## 8. Add unit tests for worker metrics

These tests do not require a live Redis connection.

**Create file:** `production-intelligence-platform/tests/worker-metrics.service.test.ts`

```typescript
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";

import {
  workerMetrics
} from "../src/services/worker-metrics.service.js";

describe("worker metrics service", () => {
  afterEach(() => {
    workerMetrics.resetForTests();
  });

  it("starts with zero counters", () => {
    const metrics = workerMetrics.snapshot();

    expect(metrics.startedTotal).toBe(0);
    expect(metrics.completedTotal).toBe(0);
    expect(metrics.failedTotal).toBe(0);
    expect(metrics.activeJobs).toBe(0);
  });

  it("tracks active jobs", () => {
    workerMetrics.jobStarted();
    workerMetrics.jobStarted();

    expect(
      workerMetrics.snapshot().activeJobs
    ).toBe(2);
  });

  it("tracks completed jobs", () => {
    workerMetrics.jobStarted();
    workerMetrics.jobCompleted();

    const metrics = workerMetrics.snapshot();

    expect(metrics.startedTotal).toBe(1);
    expect(metrics.completedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
  });

  it("tracks failed jobs", () => {
    workerMetrics.jobStarted();
    workerMetrics.jobFailed();

    const metrics = workerMetrics.snapshot();

    expect(metrics.failedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
  });

  it("includes a timestamp", () => {
    const metrics = workerMetrics.snapshot();

    expect(
      Number.isNaN(
        Date.parse(metrics.sampledAt)
      )
    ).toBe(false);
  });
});
```

### What these tests prove

They prove that the in-memory counters behave as expected when their methods are called.

They do **not** prove that BullMQ will emit events in every scenario, that Redis is healthy, or that the worker is consuming jobs. Those require integration tests and runtime verification.

---

## 9. Build and test

Run the focused unit test first.

**Path:** `production-intelligence-platform/`  
**Terminal:**

```powershell
npx vitest run tests/worker-metrics.service.test.ts
```

Then run the full test suite and TypeScript build.

**Path:** `production-intelligence-platform/`  
**Terminal:**

```powershell
npm run test:run
npm run build
```

If TypeScript reports a queue type incompatibility in `queue-observability.service.ts`, resolve it using the actual BullMQ types in this repository. Do not silence the error with `any`.

If an existing test fails, compare it against the baseline before attributing the failure to this lecture.

---

## 10. Start the application and verify the API

Make sure Docker Compose has Redis and PostgreSQL running according to your existing project setup. Start the API and worker in separate terminals.

**Path:** `production-intelligence-platform/`  
**Terminal 1 — API:**

```powershell
npm run dev
```

**Path:** `production-intelligence-platform/`  
**Terminal 2 — worker:**

```powershell
npm run dev:worker
```

### Check queue metrics

**Path:** PowerShell terminal

```powershell
Invoke-RestMethod `
  http://localhost:3000/monitoring/queues |
  ConvertTo-Json -Depth 8
```

Expected response shape:

```json
{
  "success": true,
  "data": {
    "queues": [
      {
        "queue": "demo-job",
        "counts": {
          "waiting": 0,
          "active": 0,
          "delayed": 0,
          "completed": 0,
          "failed": 0,
          "waitingChildren": 0
        },
        "backlog": 0,
        "health": "healthy",
        "thresholds": {
          "maxWaiting": 10
        },
        "sampledAt": "..."
      }
    ],
    "sampledAt": "...",
    "workers": [
      {
        "worker": "external-api",
        "startedTotal": 0,
        "completedTotal": 0,
        "failedTotal": 0,
        "activeJobs": 0,
        "sampledAt": "..."
      }
    ]
  }
}
```

This is an illustrative response shape. Actual queue names, counts, timestamps, and health status depend on your runtime.

### Check that existing endpoints still work

**Path:** PowerShell terminal

```powershell
Invoke-RestMethod `
  http://localhost:3000/monitoring/queues/demo |
  ConvertTo-Json -Depth 6

Invoke-RestMethod `
  http://localhost:3000/monitoring/metrics |
  ConvertTo-Json -Depth 6
```

The demo-specific route and HTTP metrics route should remain available.

---

## 11. Generate work and observe the worker

Use the existing external API producer endpoint defined in `src/routes/external-api.routes.ts`. Inspect that file for the exact route and request body; do not assume an endpoint name or invent a payload.

1. Submit several valid jobs using that existing route.
2. Watch the worker terminal.
3. Call `GET /monitoring/queues` again.
4. Compare `waiting`, `active`, `completed`, and the worker counters.
5. Repeat after jobs have completed.

Because the simulated external API task waits approximately 200 milliseconds and the worker uses concurrency 5, jobs may complete quickly. Sample during processing if you want to observe a nonzero active count.

**Expected observation:** the queue counts describe BullMQ's retained job state, while the worker counters describe events observed since that worker process started.

---

## 12. Intentional break → diagnose → fix → retest

### Break A — Remove the start metric

Temporarily comment out this line in `src/workers/external-api.worker.ts`:

```typescript
workerMetrics.jobStarted();
```

Restart the worker, enqueue a job, and inspect `/monitoring/queues`.

**Expected symptom:** `startedTotal` remains unchanged, and `activeJobs` will not correctly reflect the job during processing.

**Root cause:** the worker processor no longer reports the start event to the metrics service.

**Fix:** restore the line before the job-start log.

### Break B — Lower the backlog threshold

In `src/services/queue-observability.service.ts`, temporarily change:

```typescript
const MAX_WAITING_JOBS = 10;
```

to:

```typescript
const MAX_WAITING_JOBS = 0;
```

With at least one waiting job, the endpoint should report a degraded queue and return `503`.

**Root cause:** the health rule is based on `waiting > MAX_WAITING_JOBS`.

**Fix:** restore the intended threshold of 10, or select a threshold justified by measured workload and service objectives.

### Retest

**Path:** `production-intelligence-platform/`  
**Terminal:**

```powershell
npx vitest run tests/worker-metrics.service.test.ts
npm run test:run
npm run build
```

Then repeat the runtime checks from Sections 10 and 11.

Do not mark the lecture complete until the tests and manual checks have actually run in your environment.

---

## 13. Operational limitations to remember

This implementation is intentionally a foundation, not the final monitoring architecture.

1. **Process-local worker counters:** restarting the worker resets them. Multiple workers each have their own counters.
2. **No historical metrics:** snapshots are not persisted in PostgreSQL.
3. **No retry-attempt total:** final failure events are not the same as every failed attempt.
4. **No duration distribution:** we have not added worker job-duration histograms or percentiles.
5. **No stale-worker detection:** a zero active count does not prove a worker is healthy.
6. **No atomic cross-queue snapshot:** queues are sampled asynchronously, so counts may reflect slightly different moments.
7. **Thresholds are illustrative:** a threshold of 10 is not automatically suitable for production.
8. **Worker event edge cases:** stalled jobs, process crashes, and retries need further handling before counters are used for automated decisions.

Do not treat a single metric as proof of system health. For example, a queue with zero waiting jobs can still have a worker that has crashed.

---

## 14. Final checklist

- [ ] Added `src/services/worker-metrics.service.ts`.
- [ ] Instrumented the existing external API worker.
- [ ] Added `src/services/queue-observability.service.ts`.
- [ ] Added `GET /monitoring/queues`.
- [ ] Preserved `GET /monitoring/queues/demo`.
- [ ] Preserved `GET /monitoring/metrics`.
- [ ] Added unit tests for worker counters.
- [ ] Ran focused tests.
- [ ] Ran the full test suite.
- [ ] Ran the TypeScript build.
- [ ] Tested with the API and worker running.
- [ ] Performed both intentional-break exercises and restored the code.

**Repository note:** this lecture provides the changes for you to apply; it has not itself committed these changes to your GitHub repository.

## Next lecture

**Phase 5 — Lecture 3: Worker Job Duration, Throughput, and Retry Metrics**

We will measure processing duration, calculate throughput over a defined window, distinguish failed attempts from terminal failures, and avoid misleading averages when job volume changes.