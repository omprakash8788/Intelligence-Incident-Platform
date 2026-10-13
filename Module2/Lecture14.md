# Module 2 — Lecture 14: Multiple Queues & Queue Routing

## Table of Contents

1. Learning objectives
2. Understand multiple queues
3. Understand queue routing
4. Review the existing architecture
5. Define routing contracts
6. Create the queue routing service
7. Create the routing API
8. Register the route
9. Add unit tests
10. Build and start the application
11. Test queue routing
12. Verify workload isolation
13. Break the implementation intentionally
14. Fix and retest
15. Production architecture and trade-offs
16. Final folder structure
17. Completion checklist

---

# 1. Learning Objectives

By the end of this lecture, you will understand:

- Why production systems use multiple queues.
- How to route jobs to the correct queue.
- How to separate workloads with different processing requirements.
- Why one worker should not necessarily process every type of job.
- How to test routing logic independently of Redis.
- How to verify that each queue is processed by its own worker.
- How queue separation improves isolation without automatically guaranteeing reliability.

We will extend your existing Production Intelligence & Incident Platform.

**We will not replace the existing queue implementations.**

We will reuse the queues and producers created in previous lectures.

## What we will build

A routing endpoint:

`POST /demo/routed-jobs`

It will accept requests targeting either:

- `demo` — routes to your existing `demo-job` queue.
- `external-api` — routes to your Lecture 13 `external-api` queue.

The routing service will select the appropriate producer.

---

# 2. Understand Multiple Queues

Imagine your production platform performs these jobs:

| Workload | Example | Processing requirement |
|---|---|---|
| Demo jobs | Background task simulation | General-purpose worker |
| External API | Send a request to another service | Rate-limited worker |
| Email | Send notifications | Provider-specific rate limits |
| Reports | Generate large reports | CPU/memory-aware workers |
| Incident processing | Evaluate incident rules | Predictable processing latency |

Putting every job into one queue may initially seem convenient. However, different workloads have different operational requirements.

For example, suppose you have:

- 500 report-generation jobs.
- 20 external API requests.
- 5 urgent incident-processing jobs.

If all of them share a queue and worker pool, long-running reports may delay other work.

Multiple queues allow you to configure and operate workloads separately.

## Important distinction

Multiple queues provide **workload separation**, but they do not automatically provide:

- Guaranteed job ordering across queues.
- Global rate limiting across all queues.
- Guaranteed priority across queues.
- Exactly-once external side effects.
- Automatic fairness between workloads.

Those properties require additional design.

---

# 3. Understand Queue Routing

Queue routing means deciding which queue should receive a job.

Our architecture will look like this:

```text
                     Express API
                          |
                          v
                  Queue Routing Service
                          |
                +---------+---------+
                |                   |
                v                   v
          Demo Producer       External API Producer
                |                   |
                v                   v
          demo-job queue      external-api queue
                |                   |
                v                   v
           Demo Worker       Rate-Limited Worker
                |                   |
                v                   v
          Demo processor     External API processor
```

The routing service is responsible for choosing a destination.

It should not directly implement the work performed by the workers.

## Why keep the routing service separate?

Without a routing service, controllers may gradually accumulate queue-specific logic:

```text
Controller
  ├── validates the request
  ├── decides which queue to use
  ├── creates job payloads
  ├── sets queue-specific options
  └── handles enqueueing
```

That becomes difficult to maintain as queues grow.

Instead, we use:

```text
Controller
    |
    v
Routing Service
    |
    +--> Demo Producer
    |
    +--> External API Producer
```

The controller handles HTTP concerns. The service handles routing decisions.

---

# 4. Review the Existing Architecture

This lecture assumes the previous lectures have created these files:

```text
src/
├── queues/
│   ├── demo.queue.ts
│   ├── external-api.queue.ts
│   ├── jobs/
│   │   ├── demo.job.ts
│   │   └── external-api.job.ts
│   └── producers/
│       ├── demo.producer.ts
│       └── external-api.producer.ts
├── routes/
│   ├── demo-queue.routes.ts
│   └── external-api.routes.ts
├── services/
│   └── demo-job.service.ts
├── workers/
│   ├── demo.worker.ts
│   └── external-api.worker.ts
├── app.ts
└── workers.ts
```

Your existing demo producer accepts a job payload and optional settings:

```ts
addDemoJob(
  data,
  {
    priority
  }
);
```

Your external API producer accepts a message:

```ts
enqueueExternalApiRequest(message);
```

Use your actual existing files as the source of truth. Do not recreate them if they already exist.

**Before starting:** confirm that Lecture 13 builds successfully and that both existing worker implementations are present.

---

# 5. Define Routing Contracts

We want TypeScript to distinguish between two valid routing requests.

A demo job requires a mode and can optionally specify a priority.

An external API job only requires a message.

## File: `src/services/queue-routing.types.ts`

**Action:** Create this file.

```ts
import type {
  DemoJobMode,
  DemoJobPriority
} from "../queues/jobs/demo.job.js";

export type QueueTarget =
  | "demo"
  | "external-api";

export interface DemoQueueRequest {
  target: "demo";
  message: string;
  mode: DemoJobMode;
  priority?: DemoJobPriority;
}

export interface ExternalApiQueueRequest {
  target: "external-api";
  message: string;
}

export type QueueRoutingRequest =
  | DemoQueueRequest
  | ExternalApiQueueRequest;
```

## Why use a discriminated union?

Notice this property:

```ts
target: "demo";
```

It tells TypeScript which request shape is valid.

When `target` is `"demo"`, the request must include `mode`.

When `target` is `"external-api"`, a demo-specific mode is not required.

This prevents us from treating every queue as if it accepted identical job data.

## Important

`priority` is optional because your existing producer applies its default priority when no priority is supplied.

We are reusing the existing `DemoJobMode` and `DemoJobPriority` types. This avoids maintaining duplicate type definitions.

---

# 6. Create the Queue Routing Service

## File: `src/services/queue-routing.service.ts`

**Action:** Create this file.

```ts
import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

import {
  enqueueExternalApiRequest
} from "../queues/producers/external-api.producer.js";

import type {
  QueueRoutingRequest
} from "./queue-routing.types.js";

export const routeQueueJob = async (
  request: QueueRoutingRequest
) => {
  switch (request.target) {
    case "demo": {
      return addDemoJob(
        {
          message: request.message,
          mode: request.mode
        },
        {
          priority: request.priority
        }
      );
    }

    case "external-api": {
      return enqueueExternalApiRequest(
        request.message
      );
    }

    default: {
      const exhaustiveCheck: never = request;

      throw new Error(
        `Unsupported queue request: ${String(exhaustiveCheck)}`
      );
    }
  }
};
```

## How the service works

### Demo request

```ts
{
  target: "demo",
  message: "Process incident",
  mode: "success",
  priority: 1
}
```

The service calls `addDemoJob()`.

The producer then submits the job to the existing `demo-job` queue.

### External API request

```ts
{
  target: "external-api",
  message: "Notify external service"
}
```

The service calls `enqueueExternalApiRequest()`.

That producer submits the job to `external-api`, where the Lecture 13 rate-limited worker processes it.

## Why use `never`?

The exhaustive check helps TypeScript identify missing routing branches if you later add another member to `QueueRoutingRequest` but forget to implement its destination.

It is a compile-time safety technique, not a substitute for validating incoming HTTP requests.

---

# 7. Create the Routing API

The HTTP request body is untrusted input. A TypeScript interface alone does not validate incoming JSON at runtime.

We will explicitly validate the target, message, mode, and priority.

## File: `src/routes/queue-routing.routes.ts`

**Action:** Create this file.

```ts
import { Router } from "express";

import type {
  DemoJobMode,
  DemoJobPriority
} from "../queues/jobs/demo.job.js";

import {
  routeQueueJob
} from "../services/queue-routing.service.js";

const router = Router();

const isDemoJobMode = (
  value: unknown
): value is DemoJobMode => {
  return (
    typeof value === "string" &&
    [
      "success",
      "slow",
      "failure",
      "fail-twice",
      "retryable",
      "non-retryable",
      "delayed",
      "progress"
    ].includes(value)
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

router.post(
  "/demo/routed-jobs",
  async (req, res, next) => {
    try {
      const body: unknown = req.body;

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST_BODY",
            message:
              "Request body must be a JSON object"
          }
        });

        return;
      }

      const requestBody = body as Record<
        string,
        unknown
      >;

      const target = requestBody.target;
      const message = requestBody.message;

      if (
        typeof message !== "string" ||
        message.trim().length === 0
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

      const normalizedMessage = message.trim();

      if (normalizedMessage.length > 1000) {
        res.status(400).json({
          success: false,
          error: {
            code: "MESSAGE_TOO_LONG",
            message:
              "message must not exceed 1000 characters"
          }
        });

        return;
      }

      if (target === "demo") {
        const mode = requestBody.mode;
        const priority = requestBody.priority;

        if (!isDemoJobMode(mode)) {
          res.status(400).json({
            success: false,
            error: {
              code: "INVALID_DEMO_MODE",
              message:
                "mode must be a supported demo job mode"
            }
          });

          return;
        }

        if (
          priority !== undefined &&
          !isDemoJobPriority(priority)
        ) {
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

        const result = await routeQueueJob({
          target: "demo",
          message: normalizedMessage,
          mode,
          ...(priority === undefined
            ? {}
            : { priority })
        });

        res.status(202).json({
          success: true,
          data: {
            target: "demo",
            result
          }
        });

        return;
      }

      if (target === "external-api") {
        const result = await routeQueueJob({
          target: "external-api",
          message: normalizedMessage
        });

        res.status(202).json({
          success: true,
          data: {
            target: "external-api",
            result
          }
        });

        return;
      }

      res.status(400).json({
        success: false,
        error: {
          code: "INVALID_QUEUE_TARGET",
          message:
            'target must be "demo" or "external-api"'
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

## Important implementation details

### 7.1 Why is the body typed as `unknown`?

Express request bodies come from clients. They must not be trusted simply because the application uses TypeScript.

We narrow the type before using the values.

### 7.2 Why validate the mode again?

The existing demo job type defines valid modes at compile time. HTTP requests arrive at runtime, so the controller must validate them separately.

If you add a new mode to `DemoJobMode`, update `isDemoJobMode()` as well. For a larger application, a shared runtime schema is preferable to maintaining parallel lists.

### 7.3 Why return `202 Accepted`?

The request has been accepted for asynchronous processing. The worker may finish later or fail.

A successful enqueue is not proof that the external operation succeeded.

---

# 8. Register the Route

## File: `src/app.ts`

**Action:** Add this import alongside your other route imports.

```ts
import queueRoutingRoutes
  from "./routes/queue-routing.routes.js";
```

**Action:** Register it with the other routes, before your not-found and error middleware.

```ts
app.use(queueRoutingRoutes);
```

Preserve all existing route registrations and middleware order.

Do not replace your entire `app.ts` file with a shortened example.

## Route registration rule

The route must be registered before your not-found middleware. Otherwise, the request may receive a 404 before it reaches the routing controller.

The routing service itself does not need to be registered anywhere; it is a regular imported module.

---

# 9. Add Unit Tests

We will test routing decisions independently of Redis and BullMQ.

These tests mock the producers, so they verify that the service selects the correct destination without creating real jobs.

## File: `tests/queue-routing.service.test.ts`

**Action:** Create this file.

```ts
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  addDemoJob
} from "../src/queues/producers/demo.producer.js";

import {
  enqueueExternalApiRequest
} from "../src/queues/producers/external-api.producer.js";

import {
  routeQueueJob
} from "../src/services/queue-routing.service.js";

vi.mock(
  "../src/queues/producers/demo.producer.js",
  () => ({
    addDemoJob: vi.fn()
  })
);

vi.mock(
  "../src/queues/producers/external-api.producer.js",
  () => ({
    enqueueExternalApiRequest: vi.fn()
  })
);

describe(
  "queue routing service",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it(
      "routes demo jobs to the demo producer",
      async () => {
        vi.mocked(addDemoJob).mockResolvedValue("demo-job-1");

        const result = await routeQueueJob({
          target: "demo",
          message: "Process incident",
          mode: "success",
          priority: 1
        });

        expect(addDemoJob).toHaveBeenCalledWith(
          {
            message: "Process incident",
            mode: "success"
          },
          {
            priority: 1
          }
        );

        expect(
          enqueueExternalApiRequest
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          jobId: "demo-job-1"
        });
      }
    );

    it(
      "routes external API jobs to the external API producer",
      async () => {
        vi.mocked(
          enqueueExternalApiRequest
        ).mockResolvedValue({
          jobId: "external-job-1"
        } as Awaited<
          ReturnType<
            typeof enqueueExternalApiRequest
          >
        >);

        const result = await routeQueueJob({
          target: "external-api",
          message: "Notify external service"
        });

        expect(
          enqueueExternalApiRequest
        ).toHaveBeenCalledWith(
          "Notify external service"
        );

        expect(addDemoJob).not.toHaveBeenCalled();

        expect(result).toEqual({
          jobId: "external-job-1"
        });
      }
    );
  }
);
```

## Important test compatibility note

The mocks above use illustrative return values. If your actual producers return a different object shape, change the mock values to match the real return types rather than modifying production code just to satisfy the test.

If `addDemoJob()` or `enqueueExternalApiRequest()` returns a BullMQ `Job` rather than a small result object, use a minimal correctly typed mock or adapt the assertions to the producer's actual return contract.

The purpose of the test is to prove routing, not to duplicate BullMQ's implementation.

---

# 10. Build and Start the Application

Open PowerShell.

## Step 1: Navigate to the project

```powershell
cd D:\Production-Intelligence-Incident-Platform\production-intelligence-platform
```

## Step 2: Build

```powershell
npm run build
```

Expected result: TypeScript compilation succeeds.

If the build fails, do not proceed until the errors are resolved.

## Step 3: Run unit tests

```powershell
npm run test:run
```

Expected result: both queue-routing service tests pass.

If Vitest does not discover `tests/queue-routing.service.test.ts`, inspect your existing Vitest configuration and align the test file location with the project's test-discovery pattern.

## Step 4: Start dependencies

```powershell
docker compose up -d postgres redis
```

Verify the containers:

```powershell
docker compose ps
```

This lecture uses Redis for BullMQ. PostgreSQL remains part of the platform but is not directly used by this routing service.

## Step 5: Start the API

Terminal 1:

```powershell
npm run dev
```

## Step 6: Start the workers

Terminal 2:

```powershell
npm run dev:worker
```

The existing demo worker and Lecture 13 external API worker must both be started by your existing worker lifecycle.

Do not start duplicate workers manually if `workers.ts` already starts them.

---

# 11. Test Queue Routing

We will send requests to the routing endpoint and verify the destination.

## Test A: Route a demo job

Run in PowerShell:

```powershell
$body = @{
  target = "demo"
  message = "Lecture 14 demo routing test"
  mode = "success"
  priority = 5
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/routed-jobs" `
  -ContentType "application/json" `
  -Body $body
```

Expected result:

- HTTP 202.
- `success` is `true`.
- `data.target` is `"demo"`.
- The response contains the producer's result.

Check the worker logs for the existing demo worker processing the job.

## Test B: Route an external API job

```powershell
$body = @{
  target = "external-api"
  message = "Lecture 14 external routing test"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/routed-jobs" `
  -ContentType "application/json" `
  -Body $body
```

Expected result:

- HTTP 202.
- `success` is `true`.
- `data.target` is `"external-api"`.
- The external API producer returns its job details.

Check the logs for the `external-api` worker.

Remember that the Lecture 13 worker is rate-limited. If it has other waiting jobs, this request may wait before processing.

## Test C: Reject an unknown target

```powershell
$body = @{
  target = "unknown"
  message = "This should not be routed"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/routed-jobs" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_QUEUE_TARGET`.

## Test D: Reject an invalid demo mode

```powershell
$body = @{
  target = "demo"
  message = "Invalid mode test"
  mode = "send-money"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/routed-jobs" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_DEMO_MODE`.

## Test E: Reject an invalid priority

```powershell
$body = @{
  target = "demo"
  message = "Invalid priority test"
  mode = "success"
  priority = 99
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/demo/routed-jobs" `
  -ContentType "application/json" `
  -Body $body
```

Expected result: HTTP 400 with `INVALID_PRIORITY`.

---

# 12. Verify Workload Isolation

We now verify that each queue remains independent.

## Step 1: Submit jobs to both queues

Submit one demo job and one external API job using the requests above.

## Step 2: Observe the worker logs

The demo job should be processed by the demo worker.

The external API job should be processed by the external API worker.

## Step 3: Check the existing demo queue metrics

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/monitoring/queues/demo"
```

This assumes you registered the monitoring route in Lecture 12.

## Step 4: Check the external API queue metrics

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/monitoring/queues/external-api"
```

This endpoint was introduced in Lecture 13.

## Expected observations

- Demo jobs appear in the demo queue's metrics.
- External API jobs appear in the external API queue's metrics.
- The external API worker applies its configured rate limit.
- The demo worker follows its own processing and concurrency configuration.

The exact counts may change between requests because the workers process jobs asynchronously.

**Do not assume a queue is empty just because a previous response reported zero waiting jobs.** Inspect the queue again if you need its current state.

---

# 13. Break the Implementation Intentionally

We will intentionally introduce a routing bug.

## Break A: Route external API requests to the demo producer

### File: `src/services/queue-routing.service.ts`

**Action:** Temporarily replace the external API branch with this incorrect code.

```ts
case "external-api": {
  return addDemoJob(
    {
      message: request.message,
      mode: "success"
    },
    {
      priority: 5
    }
  );
}
```

This code is intentionally wrong. Do not leave it in the application.

Depending on your types and configuration, TypeScript may still compile because the demo producer accepts this payload. That is exactly why runtime routing tests matter.

## Test the broken implementation

Run the unit tests:

```powershell
npm run test:run
```

Expected result: the external API routing test fails because `enqueueExternalApiRequest()` was not called.

The test catches the architectural bug even though the incorrect branch may be type-correct.

## Root-cause analysis

The bug is not a syntax error.

It is a **destination-selection error**.

The service sends an external API job to the wrong producer, which means:

- The job enters the wrong queue.
- The external API worker does not process it.
- The external API queue's rate limiter does not protect this misrouted job.
- Monitoring reports the work under the wrong workload.

This illustrates why queue routing requires tests that verify the selected destination.

---

# 14. Fix and Retest

### File: `src/services/queue-routing.service.ts`

**Action:** Restore the correct external API branch.

```ts
case "external-api": {
  return enqueueExternalApiRequest(
    request.message
  );
}
```

Run the tests again:

```powershell
npm run test:run
```

Expected result: both routing service tests pass.

Then rebuild:

```powershell
npm run build
```

Restart the API if necessary, submit one job to each target, and verify that the corresponding workers process them.

## Final verification checklist

- [ ] Demo requests are sent to the demo producer.
- [ ] External API requests are sent to the external API producer.
- [ ] Invalid targets return HTTP 400.
- [ ] Invalid modes return HTTP 400.
- [ ] Invalid priorities return HTTP 400.
- [ ] Unit tests detect the intentional misrouting bug.
- [ ] Unit tests pass after the fix.
- [ ] The TypeScript build succeeds.
- [ ] Queue metrics report jobs under the correct queue.

---

# 15. Production Architecture and Trade-offs

## 15.1 Queue separation is not the same as workload isolation

Separate queues help organize work, but true isolation also depends on worker allocation, CPU and memory limits, Redis capacity, and how the application handles failures.

If one worker process hosts every worker and exhausts its memory, multiple queues may still be affected.

For critical workloads, consider separate worker processes or containers.

## 15.2 Rate limits must match the external provider

The external API queue has its own rate limiter.

If another queue also calls the same provider, the combined request rate may exceed the provider's quota.

If the provider imposes an account-wide limit, coordinate the limit across every queue that uses that account.

## 15.3 Do not trust client-selected queues without controls

This lecture exposes two explicit queue targets for learning purposes.

A production application should not let clients select arbitrary internal queue names or job types. Instead, validate the allowed operation and apply authorization rules.

For example, an untrusted client should not be able to submit privileged incident-remediation jobs simply by changing a `target` field.

## 15.4 Routing rules will evolve

A growing application may route jobs by:

- Job type.
- Tenant.
- Workload priority.
- External provider.
- Resource requirements.
- Data residency.
- Business criticality.

Keep routing rules explicit and testable. Avoid a large collection of nested conditionals scattered throughout controllers.

## 15.5 Routing is not transactionally atomic with a database write

Suppose a future API stores an incident in PostgreSQL and then enqueues a job in Redis.

If the database write succeeds but enqueueing fails, the incident exists without the expected background job.

This is a dual-write problem.

A common production solution is the **Transactional Outbox Pattern**, which we will study in Module 3. Do not assume that using a routing service solves this consistency problem.

## 15.6 Observability must preserve queue identity

Logs should include the queue name and job ID wherever practical.

This makes it easier to trace a job from the HTTP request through the producer and worker.

For production systems, also track queue age, throughput, failure rates, and external-service latency.

---

# 16. Final Folder Structure

The new files introduced in this lecture are:

```text
src/
├── routes/
│   └── queue-routing.routes.ts
└── services/
    ├── queue-routing.service.ts
    └── queue-routing.types.ts

tests/
└── queue-routing.service.test.ts
```

The existing queues and producers remain in place:

```text
src/
├── queues/
│   ├── demo.queue.ts
│   ├── external-api.queue.ts
│   └── producers/
│       ├── demo.producer.ts
│       └── external-api.producer.ts
├── workers/
│   ├── demo.worker.ts
│   └── external-api.worker.ts
├── app.ts
└── workers.ts
```

This is the relevant portion of your project, not a complete replacement for your current directory structure.

---

# 17. Completion Checklist

Before moving to Lecture 15, confirm:

- [ ] I understand why multiple queues are useful.
- [ ] I understand the difference between routing and processing.
- [ ] I created the routing request types.
- [ ] I created the queue routing service.
- [ ] I created the routing API.
- [ ] I registered the route without removing existing middleware.
- [ ] I added unit tests for both routing destinations.
- [ ] The TypeScript build passes.
- [ ] The tests pass.
- [ ] I submitted a demo job and observed the demo worker.
- [ ] I submitted an external API job and observed the external API worker.
- [ ] I intentionally misrouted a job and observed the test failure.
- [ ] I restored the correct routing branch and reran the tests.
- [ ] I understand the limitations of queue separation and routing.

## Success Criteria

Lecture 14 is complete when the routing service reliably selects the intended producer, invalid requests are rejected, the tests catch the intentional misrouting bug, and the corrected implementation passes the build and runtime verification.

**Do not move to Lecture 15 until you have verified these results in your local project.**

## Next Lecture

**Module 2 — Lecture 15: Fan-Out / Fan-In Patterns**

We will learn how one incoming job can create multiple parallel jobs, and how to coordinate their results safely before considering the parent operation complete.
