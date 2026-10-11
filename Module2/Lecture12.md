## Lecture 12 — BullMQ Queue Metrics, Backlog Monitoring & Health APIs
**Goal**: Measure queue health, expose job counts through an Express API, detect a growing backlog, and distinguish a healthy API from a healthy background-processing system.
We will extend your existing Node.js, TypeScript, Express, Redis, and BullMQ project. We will keep the current queue, worker, retries, priorities, delayed jobs, progress tracking, and QueueEvents listener.
**Learning workflow**: Build → Test → Break intentionally → Understand → Fix → Verify.

### 1. Why queue metrics matter
An API can return HTTP 200 while background jobs are stuck.
For example:
```
API health:       OK
Redis health:     OK
PostgreSQL health: OK
Worker:           STOPPED
Waiting jobs:     5000
```

The API and infrastructure are reachable, but the background-processing system is not doing its work.
We need to monitor the queue itself.
Our monitoring endpoint will report:

- Waiting jobs
- Active jobs
- Delayed jobs
- Completed jobs retained by BullMQ
- Failed jobs retained by BullMQ
- Waiting backlog
- A simple queue-health assessment

A key distinction: **job counts are measurements of the queue at a particular moment, not proof that every job will eventually succeed.**

---

### 2. Understand queue states and metrics

BullMQ exposes getJobCounts() to retrieve counts for different queue states. We will use that rather than scanning every job individually.

| State | Meaning |
|---|---|
| `waiting` | Eligible jobs waiting for a worker |
| `active` | Jobs currently being processed |
| `delayed` | Jobs whose scheduled execution time has not arrived |
| `completed` | Successfully completed jobs still retained in the queue |
| `failed` | Failed jobs still retained in the queue |
| `paused` | Jobs waiting while the queue is paused |
| `waiting-children` | Jobs waiting for dependencies in a flow |

A queue count is not the same as a throughput metric. For example, completed counts retained completed jobs; it does not necessarily mean that only that many jobs have ever completed.

BullMQ also has a separate metrics API for completed and failed jobs over one-minute intervals. We will focus first on live state counts, then use them to create a basic health assessment.

---

### 3. Design the monitoring API
We will add one endpoint:
```
GET /monitoring/queues/demo
```
Example response:
```
{
  "success": true,
  "data": {
    "queue": "demo-job",
    "counts": {
      "waiting": 12,
      "active": 2,
      "delayed": 3,
      "completed": 50,
      "failed": 4,
      "paused": 0,
      "waitingChildren": 0
    },
    "backlog": 12,
    "health": "degraded",
    "thresholds": {
      "maxWaiting": 10
    }
  }
}
```

These numbers are illustrative. Your endpoint will return the actual counts from Redis.
For this lecture, our deterministic rule is:
- healthy: waiting jobs are at or below 10.
- degraded: waiting jobs exceed 10.

This is a teaching threshold, not a universal production standard. A real threshold should depend on arrival rate, processing time, job criticality, and service-level objectives.

---

### 4. Create the queue metrics service

The service should own the queue-counting logic so that the route remains small and easy to test.

**Create** src/services/demo-queue-metrics.service.ts:

```
import {
  demoQueue,
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

export type QueueHealth =
  | "healthy"
  | "degraded";

const MAX_WAITING_JOBS = 10;

export interface DemoQueueMetrics {
  queue: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused: number;
    waitingChildren: number;
  };
  backlog: number;
  health: QueueHealth;
  thresholds: {
    maxWaiting: number;
  };
  sampledAt: string;
}

export const getDemoQueueMetrics =
  async (): Promise<DemoQueueMetrics> => {
    const counts =
      await demoQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "completed",
        "failed",
        "paused",
        "waiting-children"
      );

    const normalizedCounts = {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
      waitingChildren:
        counts["waiting-children"] ?? 0
    };

    const backlog =
      normalizedCounts.waiting;

    const health: QueueHealth =
      backlog > MAX_WAITING_JOBS
        ? "degraded"
        : "healthy";

    return {
      queue: DEMO_QUEUE_NAME,
      counts: normalizedCounts,
      backlog,
      health,
      thresholds: {
        maxWaiting: MAX_WAITING_JOBS
      },
      sampledAt: new Date().toISOString()
    };
  };
```
**Why is backlog defined** as waiting?

For this initial monitor, backlog means jobs that are eligible to run but are waiting for a worker.
We deliberately exclude:
- delayed: not yet eligible.
- active: already being processed.
- waitingChildren: blocked on dependencies.

This is one useful definition of backlog, but not the only one. Later, we can add oldest waiting-job age and arrival-versus-completion rates to detect problems earlier.

---

### 5. Create the monitoring route
**Create** `src/routes/queue-monitoring.routes.ts`:
```
import {
  Router
} from "express";

import {
  getDemoQueueMetrics
} from "../services/demo-queue-metrics.service.js";

const router = Router();

router.get(
  "/monitoring/queues/demo",
  async (_req, res, next) => {
    try {
      const metrics =
        await getDemoQueueMetrics();

      const statusCode =
        metrics.health === "healthy"
          ? 200
          : 503;

      res.status(statusCode).json({
        success:
          metrics.health === "healthy",
        data: metrics
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```
**Why return HTTP 503 for a degraded queue?**

This endpoint is a **queue-health assessment**, not simply a metrics endpoint. Under our teaching rule, a backlog above the threshold produces **503 Service Unavailable**.

That choice has consequences: monitoring tools may interpret **503** as an unhealthy endpoint, and a load balancer could make routing decisions based on it. For a production system, consider separating:
- A metrics endpoint that returns **200** when metrics were retrieved successfully.
- A readiness endpoint that returns **503** when the service cannot accept or process work as required.

Do not make the whole API unready solely because a noncritical background queue has a backlog.

---

### 6. Register the route

**File**: `src/app.ts`

Add this import alongside your existing route imports:
```
import queueMonitoringRoutes
  from "./routes/queue-monitoring.routes.js";
```
Register it alongside your other routes, before your not-found middleware and error handler:
app.use(queueMonitoringRoutes);


Do not duplicate existing middleware or change the established error-handler order.

Your relevant route-registration section should look conceptually like this:
```
app.use(healthRoutes);
app.use(incidentRoutes);
app.use(demoQueueRoutes);
app.use(queueMonitoringRoutes);

// Keep existing not-found middleware here.
// Keep existing error middleware last.
```

Use your actual import names for **healthRoutes** and **incidentRoutes**; retain the existing imports in your project.

---

### 7. Build and start the application
From your project root:
#### PowerShell — compile TypeScript
```
npm run build
```

Resolve any compilation errors before continuing.

Start the API.
#### Terminal 1 — API
```
npm run dev
```

Start the worker.

#### Terminal 2 — worker and QueueEvents

```
npm run dev:worker
```

Keep the worker running for the initial health check.

---

### 8. Test the queue metrics endpoint
### PowerShell — request live queue metrics
```
Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/monitoring/queues/demo
```

If the waiting count is at or below 10, the response should have HTTP **200**.

Example response:
```
{
  "success": true,
  "data": {
    "queue": "demo-job",
    "counts": {
      "waiting": 0,
      "active": 0,
      "delayed": 0,
      "completed": 12,
      "failed": 2,
      "paused": 0,
      "waitingChildren": 0
    },
    "backlog": 0,
    "health": "healthy",
    "thresholds": {
      "maxWaiting": 10
    },
    "sampledAt": "..."
  }
}
```
The counts above are illustrative; your results will differ.
#### Verify the JSON directly
#### PowerShell — parse the response
```
$response = Invoke-WebRequest `
  -UseBasicParsing `
  http://localhost:3000/monitoring/queues/demo

$data = $response.Content | ConvertFrom-Json

$data.data.counts | Format-List
$data.data.health
$data.data.sampledAt
```

Confirm that the endpoint reports counts from BullMQ and a timestamp for the measurement.

---

### 9. Simulate a growing backlog
Now we will intentionally stop the worker and enqueue enough jobs to cross our threshold.

#### Step 1 — Stop the worker

In Terminal 2, press `Ctrl+C`.

Ensure no other process is consuming the `demo-job` queue.

Keep the API running. The API and worker are separate processes, so the producer can still enqueue jobs while the worker is stopped.

#### Step 2 — Enqueue 12 jobs

#### PowerShell — create backlog
```
for ($i = 1; $i -le 12; $i++) {
  $body = @{
    message = "Lecture 12 backlog test $i"
    mode = "success"
    priority = 5
  } | ConvertTo-Json

  Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri http://localhost:3000/demo/jobs `
    -ContentType "application/json" `
    -Body $body | Out-Null
}

Write-Host "Submitted 12 backlog-test jobs."
```
#### Step 3 — Check the metrics
#### PowerShell — inspect queue health

```
try {
  Invoke-WebRequest `
    -UseBasicParsing `
    http://localhost:3000/monitoring/queues/demo
}
catch {
  $_.Exception.Response.StatusCode

  if ($_.ErrorDetails.Message) {
    $_.ErrorDetails.Message
  }
}
```
If the queue had no other waiting jobs, the expected result is:

- backlog: 12
- health: degraded
- HTTP status: 503

If existing waiting jobs were already present, the backlog will be higher. If another worker is still consuming jobs, the result may differ.

**What did we prove?**

We demonstrated that an API can remain available while its background queue is unhealthy according to a defined backlog threshold.

---

### 10. Verify recovery
Restart the worker.
Terminal 2 — start the worker again
```
npm run dev:worker
```
The worker should start processing the queued jobs. Because the jobs use the success mode, they should complete under normal operating conditions.

Poll the metrics endpoint again.

#### PowerShell — observe recovery

```
for ($i = 1; $i -le 10; $i++) {
  $response = Invoke-WebRequest `
    -UseBasicParsing `
    http://localhost:3000/monitoring/queues/demo

  $data = $response.Content | ConvertFrom-Json

  Write-Host (
    "Waiting={0}, Active={1}, Health={2}" -f `
      $data.data.counts.waiting, `
      $data.data.counts.active, `
      $data.data.health
  )

  Start-Sleep -Seconds 2
}
```
Expected pattern:
```
Waiting=12, Active=0, Health=degraded
Waiting=10, Active=2, Health=healthy
Waiting=6, Active=2, Health=healthy
Waiting=0, Active=0, Health=healthy
```

These values illustrate the intended behavior, not guaranteed output. Your worker concurrency and existing queue contents determine the actual sequence.

Notice that the simple health rule may return to `healthy` while some jobs are still waiting. That is expected because our threshold is based only on waiting-job count.

---

### 11. Intentional break and fix
We will intentionally break the backlog calculation.
Break it

**File**: `src/services/demo-queue-metrics.service.ts`

Find:
```
const backlog =
  normalizedCounts.waiting;
```

Temporarily replace it with:
```
const backlog = 0;
```
Build:
**PowerShell**
```
npm run build
```

Stop the worker, enqueue 12 jobs again, and query the endpoint.
The endpoint will incorrectly report `healthy`, even when jobs are waiting.

#### Understand the failure

The queue count retrieval is still working, but the health assessment is ignoring the actual waiting count.

```
BullMQ counts
     |
     v
waiting = 12
     |
     X
backlog hardcoded to 0
     |
     v
Incorrect healthy status
```
This is a monitoring logic failure, not a Redis connection failure.

#### Fix it

**File**: `src/services/demo-queue-metrics.service.ts`
Restore:
```
const backlog =
  normalizedCounts.waiting;
```

Then rebuild:
#### PowerShell
```
npm run build
```

Restart the worker and verify that the waiting count decreases as jobs are processed.

---

### 12. Production considerations
#### 12.1 Queue counts are snapshots
Counts can change between the moment they are read and the moment the response reaches the client. Do not treat a single count as a permanent state.
#### 12.2 Add queue age, not just queue size
A queue with 100 jobs that each wait one second may be fine. A queue with only 5 critical jobs waiting for 30 minutes may be a serious incident.
Useful future metrics include:
- Age of the oldest waiting job
- Job arrival rate
- Job completion rate
- Job failure rate
- Retry rate
- Processing duration
- Worker availability

#### 12.3 Enable BullMQ's built-in metrics later

BullMQ supports per-minute completed and failed job metrics through worker metrics configuration and `Queue.getMetrics()`. The configured maxDataPoints determines how many data points are retained. Use consistent settings across workers if you rely on aggregated metrics. 

#### 12.4 Avoid unbounded job retention
Completed and failed counts depend on retention policies. If you retain every completed job forever, Redis storage can grow. If you remove completed jobs, retained counts will not represent lifetime totals.
#### 12.5 Do not expose queue administration publicly
Monitoring endpoints should be protected appropriately in production. Do not expose unrestricted queue inspection, job deletion, retry, or queue-clearing operations to unauthenticated clients.

---
