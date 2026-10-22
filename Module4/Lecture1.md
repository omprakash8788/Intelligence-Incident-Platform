# Phase 5 — Observability Engine
## Lecture 1: HTTP Metrics Foundation

**Project:** Production Intelligence & Incident Platform  
**Stack:** Node.js, TypeScript, Express, Vitest  
**Existing architecture:** `production-intelligence-platform/src/`  
**Objective:** Collect HTTP request counts, error counts, active requests, and request-duration statistics.

---

## 1. Architecture decision

We already have `requestLoggingMiddleware` and a structured logger. We will retain them and add a separate metrics service.

```text
HTTP Request
    |
    v
Request Logging Middleware
    |
    +----> Existing structured logger
    |
    +----> HTTP Metrics Service
                 |
                 +---- Request counter
                 +---- 5xx error counter
                 +---- Active request gauge
                 +---- Duration count and sum
                            |
                            v
                 GET /monitoring/metrics
```

This first version uses **in-memory metrics**. It is intentionally simple enough to test before introducing Redis, BullMQ, and PostgreSQL into the telemetry pipeline.

### Metrics definitions

| Metric | Meaning |
|---|---|
| `http_requests_total` | Total completed HTTP requests |
| `http_errors_5xx_total` | Completed HTTP responses with status 500–599 |
| `http_requests_active` | Requests currently being processed |
| `http_request_duration_ms_count` | Number of duration observations |
| `http_request_duration_ms_sum` | Sum of completed request durations |
| `http_request_duration_ms_avg` | Average duration in milliseconds |

Average duration is calculated as:

`duration sum / duration count`

It is not a p95 or p99 latency measurement. We will add distribution-based latency measurements in a later step.

## 2. Baseline: build and tests

**Working directory:** `D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Run these commands before editing anything:

```powershell
npm run build
npm run test:run
```

Record the result. If either command fails, investigate the existing failure first so that we can distinguish old problems from new ones.

## 3. Create the HTTP metrics service

**File:** `src/services/http-metrics.service.ts`

**Action:** Create this new file.

```typescript
export interface HttpMetricsSnapshot {
  http_requests_total: number;
  http_errors_5xx_total: number;
  http_requests_active: number;
  http_request_duration_ms_count: number;
  http_request_duration_ms_sum: number;
  http_request_duration_ms_avg: number;
  sampled_at: string;
}

interface HttpMetricsState {
  requestsTotal: number;
  errors5xxTotal: number;
  activeRequests: number;
  durationCount: number;
  durationSumMs: number;
}

const createInitialState = (): HttpMetricsState => ({
  requestsTotal: 0,
  errors5xxTotal: 0,
  activeRequests: 0,
  durationCount: 0,
  durationSumMs: 0
});

let state = createInitialState();

export const httpMetrics = {
  requestStarted(): void {
    state.activeRequests += 1;
  },

  requestFinished(
    statusCode: number,
    durationMs: number
  ): void {
    state.requestsTotal += 1;

    if (
      Number.isInteger(statusCode) &&
      statusCode >= 500 &&
      statusCode <= 599
    ) {
      state.errors5xxTotal += 1;
    }

    state.activeRequests = Math.max(
      0,
      state.activeRequests - 1
    );

    const safeDurationMs =
      Number.isFinite(durationMs)
        ? Math.max(0, durationMs)
        : 0;

    state.durationCount += 1;
    state.durationSumMs += safeDurationMs;
  },

  snapshot(): HttpMetricsSnapshot {
    const averageDuration =
      state.durationCount === 0
        ? 0
        : state.durationSumMs /
          state.durationCount;

    return {
      http_requests_total:
        state.requestsTotal,

      http_errors_5xx_total:
        state.errors5xxTotal,

      http_requests_active:
        state.activeRequests,

      http_request_duration_ms_count:
        state.durationCount,

      http_request_duration_ms_sum:
        state.durationSumMs,

      http_request_duration_ms_avg:
        averageDuration,

      sampled_at: new Date().toISOString()
    };
  },

  resetForTests(): void {
    state = createInitialState();
  }
};
```

### Why keep metrics separate from logging?

Logging answers questions about individual events: which request failed, which request ID was involved, and what the application was doing.

Metrics answer aggregate questions: how many requests failed, how long requests take on average, and whether traffic or errors are increasing.

We can connect these signals later without making the logger responsible for calculating every metric.

## 4. Instrument the existing request middleware

**File:** `src/middleware/request-logging.middleware.ts`

**Action:** Replace the complete file with this version. It retains the existing request log fields and adds metrics collection.

```typescript
import {
  Request,
  Response,
  NextFunction
} from "express";

import { logger } from "../logging/logger.js";
import { httpMetrics } from "../services/http-metrics.service.js";

export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startedAt = Date.now();

  httpMetrics.requestStarted();

  let finished = false;

  const recordCompletion = (): void => {
    if (finished) {
      return;
    }

    finished = true;

    const durationMs =
      Date.now() - startedAt;

    httpMetrics.requestFinished(
      res.statusCode,
      durationMs
    );

    logger.info(
      "HTTP request completed",
      {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs
      }
    );
  };

  res.once("finish", recordCompletion);

  res.once("close", () => {
    if (!finished) {
      recordCompletion();
    }
  });

  next();
};
```

### Important lifecycle detail

An HTTP response may emit `finish` or close before finishing normally. Registering both events helps ensure that a request is not counted twice and that a prematurely closed response does not leave the active-request gauge permanently elevated.

This implementation uses the final response status code and elapsed time. It does not yet distinguish client disconnects from server errors in a separate metric.

## 5. Expose the metrics endpoint

**File:** `src/routes/queue-monitoring.routes.ts`

**Action:** Replace the complete file with this version. It preserves the existing demo queue endpoint and adds the HTTP metrics endpoint.

```typescript
import {
  Router
} from "express";

import {
  getDemoQueueMetrics
} from "../services/demo-queue-metrics.service.js";

import {
  httpMetrics
} from "../services/http-metrics.service.js";

const router = Router();

router.get(
  "/monitoring/metrics",
  (_req, res) => {
    res.status(200).json({
      success: true,
      data: httpMetrics.snapshot()
    });
  }
);

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
        success: metrics.health === "healthy",
        data: metrics
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

The route is already mounted in `src/app.ts` through `queueMonitoringRoutes`. **Do not add a duplicate route registration.**

Because this router is mounted before `requestLoggingMiddleware` in the current application, requests to `/monitoring/metrics` will not be counted by that middleware. That is acceptable for this first implementation; we will review middleware ordering and scrape-request exclusion when we establish the full telemetry contract.

## 6. Unit tests for metrics

**File:** `tests/http-metrics.service.test.ts`

**Action:** Create this new file.

```typescript
import {
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import {
  httpMetrics
} from "../src/services/http-metrics.service.js";

describe("httpMetrics", () => {
  beforeEach(() => {
    httpMetrics.resetForTests();
  });

  it("starts with zero counters", () => {
    const metrics = httpMetrics.snapshot();

    expect(metrics.http_requests_total).toBe(0);
    expect(metrics.http_errors_5xx_total).toBe(0);
    expect(metrics.http_requests_active).toBe(0);
    expect(
      metrics.http_request_duration_ms_count
    ).toBe(0);
    expect(
      metrics.http_request_duration_ms_sum
    ).toBe(0);
    expect(
      metrics.http_request_duration_ms_avg
    ).toBe(0);
  });

  it("tracks active requests", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestStarted();

    expect(
      httpMetrics.snapshot().http_requests_active
    ).toBe(2);

    httpMetrics.requestFinished(200, 20);

    expect(
      httpMetrics.snapshot().http_requests_active
    ).toBe(1);
  });

  it("counts completed requests", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 25);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(404, 10);

    expect(
      httpMetrics.snapshot().http_requests_total
    ).toBe(2);
  });

  it("counts only HTTP 5xx responses as server errors", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 10);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(404, 10);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(503, 30);

    expect(
      httpMetrics.snapshot().http_errors_5xx_total
    ).toBe(1);
  });

  it("calculates average request duration", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 20);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 40);

    const metrics = httpMetrics.snapshot();

    expect(
      metrics.http_request_duration_ms_count
    ).toBe(2);

    expect(
      metrics.http_request_duration_ms_sum
    ).toBe(60);

    expect(
      metrics.http_request_duration_ms_avg
    ).toBe(30);
  });

  it("returns an ISO timestamp", () => {
    const metrics = httpMetrics.snapshot();

    expect(
      Number.isNaN(Date.parse(metrics.sampled_at))
    ).toBe(false);
  });
});
```

## 7. API test

**File:** `tests/http-metrics.api.test.ts`

**Action:** Create this new file.

```typescript
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import app from "../src/app.js";

import {
  httpMetrics
} from "../src/services/http-metrics.service.js";

describe("GET /monitoring/metrics", () => {
  afterEach(() => {
    httpMetrics.resetForTests();
  });

  it("returns a metrics snapshot", async () => {
    const response = await request(app)
      .get("/monitoring/metrics");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    expect(
      response.body.data.http_requests_total
    ).toEqual(expect.any(Number));

    expect(
      response.body.data.http_errors_5xx_total
    ).toEqual(expect.any(Number));

    expect(
      response.body.data.http_requests_active
    ).toEqual(expect.any(Number));

    expect(
      response.body.data.http_request_duration_ms_avg
    ).toEqual(expect.any(Number));

    expect(
      Number.isNaN(
        Date.parse(response.body.data.sampled_at)
      )
    ).toBe(false);
  });
});
```

This API test checks the response contract. Since the current route order means the metrics endpoint itself is not instrumented, the test does not assume that calling the endpoint increments the HTTP request count.

## 8. Run the tests

**Working directory:** `D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Run the focused tests first:

```powershell
npx vitest run tests/http-metrics.service.test.ts tests/http-metrics.api.test.ts
```

Then run the entire test suite and TypeScript build:

```powershell
npm run test:run
npm run build
```

If a test fails, capture the complete failure output before changing code. Do not assume an existing test failure is caused by this lecture.

## 9. Manual verification

**Working directory:** `D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Start the API:

```powershell
npm run dev
```

In a second PowerShell terminal, query the endpoint:

```powershell
Invoke-RestMethod http://localhost:3000/monitoring/metrics |
  ConvertTo-Json -Depth 5
```

Expected response shape:

```json
{
  "success": true,
  "data": {
    "http_requests_total": 0,
    "http_errors_5xx_total": 0,
    "http_requests_active": 0,
    "http_request_duration_ms_count": 0,
    "http_request_duration_ms_sum": 0,
    "http_request_duration_ms_avg": 0,
    "sampled_at": "2026-10-22T00:00:00.000Z"
  }
}
```

The timestamp is illustrative. Actual values depend on the requests received since the API process started.

Generate traffic through an existing route that passes through `requestLoggingMiddleware`. For example, use a known health endpoint:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
```

Query `/monitoring/metrics` again. If the health endpoint is mounted as shown in your current application, the completed request should appear in the metrics snapshot.

If the health endpoint path differs in your local checkout, use the path registered in `src/routes/health.routes.ts`.

## 10. Intentionally break it, then fix it

### Experiment A — Break request counting

**File:** `src/middleware/request-logging.middleware.ts`

Temporarily remove this call from `recordCompletion`:

```typescript
httpMetrics.requestFinished(
  res.statusCode,
  durationMs
);
```

Make a request to a route instrumented by the middleware and query the metrics endpoint.

**Expected observation:** the completed-request count and duration totals do not increase, and the active-request count remains elevated.

### Root cause

`requestStarted()` increments the active-request gauge. The completion handler must call `requestFinished()` to decrement the gauge and update the aggregate counters.

### Fix

Restore the call:

```typescript
httpMetrics.requestFinished(
  res.statusCode,
  durationMs
);
```

Re-run the focused tests and build.

### Experiment B — Verify the 5xx counter

Call `requestFinished(503, 30)` in a temporary unit test after calling `requestStarted()`.

**Expected result:** the completed-request count increases by one and the 5xx error count increases by one.

Then test `requestFinished(404, 10)`.

**Expected result:** the completed-request count increases, but the 5xx error count does not.

Remove temporary test changes after verification.

## 11. Limitations of this first version

- **Process-local state:** restarting the API resets all metrics.
- **Multiple instances:** each process would report its own counters; the values are not globally aggregated.
- **Average latency only:** an average can hide slow outliers. Percentiles require a histogram or another distribution-aware approach.
- **No durable telemetry:** metrics are not written to PostgreSQL or Redis.
- **No worker metrics yet:** BullMQ retries, failed jobs, queue depth, and worker utilization remain separate signals.
- **No distributed traces yet:** request IDs are useful for correlation, but they are not a complete tracing system.
- **Scrape route exclusion:** the current Express middleware order does not instrument the metrics endpoint itself.

These are deliberate boundaries, not claims that the observability engine is complete.

## 12. Final folder structure

The only new source and test files in this lecture are:

```text
production-intelligence-platform/
├── src/
│   ├── middleware/
│   │   └── request-logging.middleware.ts   # Modified
│   ├── routes/
│   │   └── queue-monitoring.routes.ts       # Modified
│   └── services/
│       └── http-metrics.service.ts          # New
└── tests/
    ├── http-metrics.service.test.ts         # New
    └── http-metrics.api.test.ts             # New
```

No new migration is required. Do not create a root-level `database/` folder, and do not modify `src/workers.ts` for this lecture.

## 13. Success criteria

- [ ] Baseline build and tests were recorded.
- [ ] HTTP metrics service exists.
- [ ] Request middleware records completion exactly once.
- [ ] 5xx responses are counted separately from 4xx responses.
- [ ] Active requests return to zero after completed requests.
- [ ] Average duration matches the test observations.
- [ ] Metrics endpoint returns the documented response shape.
- [ ] Focused tests pass.
- [ ] Full test suite and TypeScript build pass.
- [ ] Intentional break was reproduced and fixed.
- [ ] Existing demo queue monitoring still works.

**Do not move to the next lecture until the success criteria are verified.**

## 14. Next lecture

**Phase 5 — Lecture 2: Queue and Worker Metrics**

We will inspect and extend the existing BullMQ instrumentation to capture queue depth, active and completed jobs, failed jobs, retries, throughput, and worker activity. Then we will decide which measurements belong in the live metrics snapshot and which need to be persisted for historical analysis.
