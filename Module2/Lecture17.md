# Module 2 — Lecture 17: Batch Jobs & Bulk Enqueue

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [The Problem: Enqueuing Jobs One at a Time](#2-the-problem-enqueuing-jobs-one-at-a-time)
3. [How BullMQ Bulk Enqueue Works](#3-how-bullmq-bulk-enqueue-works)
4. [Architecture](#4-architecture)
5. [Implementation](#5-implementation)
6. [Register the Route](#6-register-the-route)
7. [Tests](#7-tests)
8. [Build and Run](#8-build-and-run)
9. [API Verification](#9-api-verification)
10. [Intentional Break → Understand → Fix](#10-intentional-break--understand--fix)
11. [Failure Scenarios and Production Trade-offs](#11-failure-scenarios-and-production-trade-offs)
12. [Final Folder Structure](#12-final-folder-structure)
13. [Success Criteria](#13-success-criteria)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why batch processing is useful in backend systems.
- The difference between individual enqueue operations and bulk enqueue.
- How to use BullMQ's `Queue.addBulk()`.
- How to validate batch input before touching Redis.
- How to return job IDs to API clients.
- How to test bulk enqueue without requiring Redis.
- What happens when a batch is too large or contains invalid data.
- Why bulk enqueue does not mean that jobs execute simultaneously.

### Our use case

Imagine our Production Intelligence & Incident Platform needs to process 50 independent tasks.

Examples include:

- Processing a group of incident notifications.
- Recalculating metrics for many services.
- Sending a collection of operational notifications.
- Running independent health-analysis jobs.
- Importing records from an external system.

We want to submit many jobs in a single bulk operation instead of making one Redis enqueue request for each job.

For this lecture, we'll reuse your existing `demo-job` queue and worker. We will **not** create another Redis connection, another worker, or a new queue lifecycle.

This isolates the concept we want to learn.

---

## 2. The Problem: Enqueuing Jobs One at a Time

Suppose we want to enqueue 100 independent jobs.

A simple implementation might look like this.

**Illustrative example — do not add this code to the project.**

```ts
for (const message of messages) {
  await demoQueue.add("demo-job", {
    message,
    mode: "success",
    priority: 5
  });
}
```

This implementation awaits each enqueue before starting the next one.

The sequence is:

1. Enqueue job 1.
2. Wait for the Redis operation.
3. Enqueue job 2.
4. Wait for the Redis operation.
5. Continue until all jobs have been submitted.

For large batches, this can introduce unnecessary round-trip overhead.

### Why not simply use `Promise.all()`?

Another option is:

```ts
await Promise.all(
  messages.map((message) =>
    demoQueue.add("demo-job", {
      message,
      mode: "success",
      priority: 5
    })
  )
);
```

This can start many individual enqueue operations concurrently, but it still represents multiple individual add operations.

It also creates potentially large amounts of concurrent work if the input contains thousands of items.

BullMQ offers a purpose-built alternative.

---

## 3. How BullMQ Bulk Enqueue Works

BullMQ provides `Queue.addBulk()`.

Conceptually:

```ts
await demoQueue.addBulk([
  {
    name: "batch-demo-job",
    data: {
      message: "Process incident A",
      mode: "success",
      priority: 5
    }
  },
  {
    name: "batch-demo-job",
    data: {
      message: "Process incident B",
      mode: "success",
      priority: 5
    }
  }
]);
```

`addBulk()` submits multiple jobs through a bulk operation.

### Important distinction

| Concept | Meaning |
|---|---|
| Bulk enqueue | Submit multiple jobs together |
| Worker concurrency | Number of jobs a worker can process concurrently |
| Job ordering | The order in which jobs are eligible to execute |
| Batch size | Number of jobs submitted in one batch |
| Rate limiting | Restricts processing frequency or throughput |

Bulk enqueue does **not** guarantee that all jobs start immediately or run simultaneously.

Your existing worker still controls processing. Its concurrency, retries, rate limits, and job priorities continue to affect execution.

### What happens when a bulk operation fails?

Do not assume every kind of bulk operation is a database transaction.

`addBulk()` is implemented as a bulk Redis operation, but it is not a general-purpose transactional workflow spanning your database, external APIs, and other queues.

We will return to this in the production trade-offs section.

---

## 4. Architecture

We'll add a small service and an Express route.

```text
HTTP Client
    |
    v
POST /demo/batches
    |
    v
Validate request body
    |
    v
Batch Enqueue Service
    |
    v
demoQueue.addBulk(...)
    |
    v
Redis / BullMQ
    |
    v
Existing Demo Worker
    |
    v
Process each job
```

### Files involved

| Action | File |
|---|---|
| Create | `src/services/batch-enqueue.service.ts` |
| Create | `src/routes/batch.routes.ts` |
| Create | `tests/batch-enqueue.service.test.ts` |
| Modify | `src/app.ts` |

We will not modify `src/workers.ts` because the existing demo worker already consumes jobs from the queue.

We will also leave these existing files unchanged:

- `src/queues/demo.queue.ts`
- `src/queues/jobs/demo.job.ts`
- `src/workers/demo.worker.ts`
- `src/queues/bullmq.connection.ts`

---

## 5. Implementation

### 5.1 Create the batch enqueue service

**File: `src/services/batch-enqueue.service.ts`**

**Action: CREATE this file.**

The service accepts a list of messages, builds the BullMQ bulk-job input, submits the jobs, and returns their IDs.

```ts
import { demoQueue } from "../queues/demo.queue.js";

const MAX_BATCH_SIZE = 100;
const MAX_MESSAGE_LENGTH = 500;

export interface BatchEnqueueResult {
  count: number;
  jobIds: string[];
}

export const enqueueDemoBatch = async (
  messages: string[]
): Promise<BatchEnqueueResult> => {
  if (!Array.isArray(messages)) {
    throw new TypeError("Messages must be an array");
  }

  if (
    messages.length === 0 ||
    messages.length > MAX_BATCH_SIZE
  ) {
    throw new RangeError(
      `Batch size must be between 1 and ${MAX_BATCH_SIZE}`
    );
  }

  for (const message of messages) {
    if (
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      throw new TypeError(
        `Each message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
      );
    }
  }

  const jobs = await demoQueue.addBulk(
    messages.map((message) => ({
      name: "batch-demo-job",
      data: {
        message: message.trim(),
        mode: "success" as const,
        priority: 5 as const
      }
    }))
  );

  return {
    count: jobs.length,
    jobIds: jobs.map((job) => job.id).filter(
      (jobId): jobId is string => typeof jobId === "string"
    )
  };
};
```

### Understand the implementation

**Why `MAX_BATCH_SIZE = 100`?**

It gives our API a defined upper limit. Without a limit, a client could submit an extremely large payload and consume excessive memory, Redis capacity, or worker capacity.

The value `100` is a teaching default, not a universal production recommendation.

**Why validate in the service?**

Route validation protects the HTTP boundary. Service-level validation protects the operation when it is called from other parts of the application.

The service should not rely solely on an HTTP route to enforce its assumptions.

**Why use `message.trim()`?**

It removes leading and trailing whitespace before storing the message.

**Why use `as const`?**

Your existing `DemoJobData` uses a union type for job modes and priorities. These assertions preserve the literal types `"success"` and `5` instead of widening them to `string` and `number`.

**Why return job IDs?**

The client needs identifiers to correlate submitted work with later status checks or logs.

The result count reflects the number of returned jobs, not the number of jobs that have already completed.

---

### 5.2 Create the Express route

**File: `src/routes/batch.routes.ts`**

**Action: CREATE this file.**

The route validates the HTTP payload and calls the service.

```ts
import { Router } from "express";
import { enqueueDemoBatch } from "../services/batch-enqueue.service.js";

export const batchRoutes = Router();

const MAX_BATCH_SIZE = 100;
const MAX_MESSAGE_LENGTH = 500;

batchRoutes.post("/", async (req, res, next) => {
  try {
    const items: unknown = req.body?.items;

    if (!Array.isArray(items)) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "The items field must be an array"
        }
      });
      return;
    }

    if (
      items.length === 0 ||
      items.length > MAX_BATCH_SIZE
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `Submit between 1 and ${MAX_BATCH_SIZE} items`
        }
      });
      return;
    }

    const validItems = items.every(
      (item: unknown) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= MAX_MESSAGE_LENGTH
    );

    if (!validItems) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message:
            `Each item must be a non-empty string of at most ${MAX_MESSAGE_LENGTH} characters`
        }
      });
      return;
    }

    const result = await enqueueDemoBatch(items as string[]);

    res.status(202).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});
```

### Why return HTTP 202?

`202 Accepted` communicates that the server accepted the work for asynchronous processing.

It does not claim that the jobs have finished.

If Redis is unavailable, the service will throw and the error will pass to your existing error middleware. The API must not report success when enqueueing fails.

### Why call `next(error)`?

Your application already has centralized error handling. Forwarding unexpected errors lets the existing error middleware determine the appropriate HTTP response and logging behavior.

We intentionally avoid creating a second, competing error-handling system.

---

## 6. Register the Route

**File: `src/app.ts`**

**Action: MODIFY this file.**

Do not replace your entire application file. Preserve its existing middleware order, security configuration, request IDs, health routes, incident routes, 404 middleware, and error middleware.

### Step 1: Add the import

Add this import alongside your other route imports:

```ts
import { batchRoutes } from "./routes/batch.routes.js";
```

### Step 2: Register the route

Register the new route after JSON-body parsing and before your not-found middleware.

```ts
app.use("/demo/batches", batchRoutes);
```

For example, the relevant order should be equivalent to:

```ts
app.use(express.json());

// Preserve your existing middleware and route registrations.

app.use("/demo/batches", batchRoutes);

// Keep your existing not-found middleware after all routes.
// Keep your existing error middleware last.
```

**Important:** This is an insertion guide, not a replacement for your complete `src/app.ts`. Do not duplicate `express.json()` if it is already registered.

The endpoint will be:

```text
POST http://localhost:3000/demo/batches
```

---

## 7. Tests

We'll unit-test the service without requiring a running Redis server.

The test will mock `demoQueue.addBulk()` and verify that the service submits the correct jobs and returns their IDs.

### 7.1 Create the service test

**File: `tests/batch-enqueue.service.test.ts`**

**Action: CREATE this file.**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/queues/demo.queue.js", () => ({
  demoQueue: {
    addBulk: vi.fn()
  }
}));

import { demoQueue } from "../src/queues/demo.queue.js";
import { enqueueDemoBatch } from "../src/services/batch-enqueue.service.js";

describe("enqueueDemoBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits multiple jobs in one bulk call", async () => {
    vi.mocked(demoQueue.addBulk).mockResolvedValue([
      { id: "job-1" },
      { id: "job-2" }
    ] as Awaited<ReturnType<typeof demoQueue.addBulk>>);

    const result = await enqueueDemoBatch([
      "Incident A",
      "Incident B"
    ]);

    expect(demoQueue.addBulk).toHaveBeenCalledTimes(1);

    expect(demoQueue.addBulk).toHaveBeenCalledWith([
      {
        name: "batch-demo-job",
        data: {
          message: "Incident A",
          mode: "success",
          priority: 5
        }
      },
      {
        name: "batch-demo-job",
        data: {
          message: "Incident B",
          mode: "success",
          priority: 5
        }
      }
    ]);

    expect(result).toEqual({
      count: 2,
      jobIds: ["job-1", "job-2"]
    });
  });

  it("trims message whitespace", async () => {
    vi.mocked(demoQueue.addBulk).mockResolvedValue([
      { id: "job-1" }
    ] as Awaited<ReturnType<typeof demoQueue.addBulk>>);

    const result = await enqueueDemoBatch([
      "  Incident A  "
    ]);

    expect(demoQueue.addBulk).toHaveBeenCalledWith([
      {
        name: "batch-demo-job",
        data: {
          message: "Incident A",
          mode: "success",
          priority: 5
        }
      }
    ]);

    expect(result.jobIds).toEqual(["job-1"]);
  });

  it("rejects an empty batch before enqueueing", async () => {
    await expect(
      enqueueDemoBatch([])
    ).rejects.toThrow(RangeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than 100 items", async () => {
    const messages = Array.from(
      { length: 101 },
      (_, index) => `Incident ${index + 1}`
    );

    await expect(
      enqueueDemoBatch(messages)
    ).rejects.toThrow(RangeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("rejects a blank message", async () => {
    await expect(
      enqueueDemoBatch(["   "])
    ).rejects.toThrow(TypeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("rejects a message longer than 500 characters", async () => {
    await expect(
      enqueueDemoBatch(["a".repeat(501)])
    ).rejects.toThrow(TypeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("propagates an enqueue failure", async () => {
    vi.mocked(demoQueue.addBulk).mockRejectedValue(
      new Error("Redis unavailable")
    );

    await expect(
      enqueueDemoBatch(["Incident A"])
    ).rejects.toThrow("Redis unavailable");
  });
});
```

### 7.2 Important note about the mocked BullMQ jobs

The mock above intentionally supplies only the `id` field because the service reads only `job.id`.

If your installed BullMQ type definitions reject the simplified mock objects, use a fully typed job factory matching the installed BullMQ version rather than weakening types across the application.

The test should verify the behavior of our service, not the internal implementation of BullMQ.

### 7.3 Run the test

From the project root:

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/batch-enqueue.service.test.ts
```

Expected result:

- The service test file passes.
- Invalid batches are rejected.
- `addBulk()` is not called for invalid input.
- A valid batch calls `addBulk()` exactly once.
- Enqueue errors propagate to the caller.

If TypeScript reports an error in the test mock, resolve that type mismatch before proceeding.

---

## 8. Build and Run

Run these commands from:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

### Step 1: Compile TypeScript

**Terminal: PowerShell**

```powershell
npm run build
```

Expected: TypeScript compilation completes without errors.

### Step 2: Run the complete test suite

**Terminal: PowerShell**

```powershell
npm run test:run
```

Expected: Existing tests continue to pass alongside the new batch service tests.

If an existing test fails, inspect the specific failure rather than changing unrelated tests.

### Step 3: Start the API

**Terminal 1: PowerShell**

```powershell
npm run dev
```

Wait for the server to finish starting.

### Step 4: Start the worker

**Terminal 2: PowerShell**

```powershell
npm run dev:worker
```

Your existing demo worker should be running and connected to Redis.

Do not start a second worker process unless you are intentionally testing multiple workers.

---

## 9. API Verification

### 9.1 Submit a valid batch

**Terminal: PowerShell**

```powershell
$body = @{
    items = @(
        "Incident A",
        "Incident B",
        "Incident C"
    )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/batches" `
    -ContentType "application/json" `
    -Body $body
```

Expected response structure:

```json
{
  "success": true,
  "data": {
    "count": 3,
    "jobIds": [
      "1",
      "2",
      "3"
    ]
  }
}
```

The IDs shown above are illustrative. BullMQ generates actual job IDs, so your response may contain different values.

### 9.2 Observe the worker

Look at the worker terminal.

The existing demo worker should receive and process the submitted jobs. The precise order of log messages depends on worker concurrency and other jobs already waiting in the queue.

The HTTP response means the jobs were accepted. It does not mean all three jobs completed before the response was returned.

### 9.3 Submit an empty batch

**Terminal: PowerShell**

```powershell
$body = @{
    items = @()
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/batches" `
    -ContentType "application/json" `
    -Body $body
```

Expected: HTTP `400 Bad Request`, with a validation error.

PowerShell may throw an exception for non-success HTTP responses. That is normal for this verification.

### 9.4 Submit a blank item

**Terminal: PowerShell**

```powershell
$body = @{
    items = @(
        "Incident A",
        "   "
    )
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/batches" `
    -ContentType "application/json" `
    -Body $body
```

Expected: HTTP `400 Bad Request`.

The invalid batch must be rejected before calling BullMQ.

### 9.5 Submit 101 items

**Terminal: PowerShell**

```powershell
$items = 1..101 | ForEach-Object {
    "Incident $_"
}

$body = @{
    items = $items
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/batches" `
    -ContentType "application/json" `
    -Body $body
```

Expected: HTTP `400 Bad Request`.

This verifies that the API rejects batches above the configured limit.

---

## 10. Intentional Break → Understand → Fix

We now test whether the implementation protects the queue from invalid requests.

### Break 1: Remove the empty-batch validation

**File: `src/routes/batch.routes.ts`**

Temporarily remove the check that rejects `items.length === 0` and batches exceeding the maximum.

Do not remove the service-level validation.

Submit an empty array:

```json
{
  "items": []
}
```

Expected behavior: the service rejects the request with a `RangeError`, which is forwarded to your existing error middleware.

Depending on your application's error mapping, the HTTP response may be a generic server error rather than the route's structured `400` validation response.

### Understand the failure

The service-level guard still prevents the invalid batch from reaching Redis.

However, route-level validation is responsible for returning a clear client-facing validation response.

This demonstrates two separate responsibilities:

- **Route validation:** reject malformed client input with a useful HTTP response.
- **Service validation:** enforce invariants even when called outside the HTTP route.

### Fix 1

Restore the route-level validation.

Submit the empty batch again.

Expected: HTTP `400 Bad Request`, with the intended validation response.

### Break 2: Simulate Redis failure

**File: `tests/batch-enqueue.service.test.ts`**

Temporarily remove the test's mock that rejects `addBulk()` and replace it with a successful mock. Run the failure test.

It should now fail because the service no longer receives the expected rejected promise.

Restore the rejected mock:

```ts
vi.mocked(demoQueue.addBulk).mockRejectedValue(
  new Error("Redis unavailable")
);
```

Run the test again.

Expected: the service propagates the error.

### Understand the failure

If the queue cannot accept the jobs, the API must not falsely claim that the batch was accepted.

The error must reach the application's error-handling path.

### Final re-test

**Terminal: PowerShell**

```powershell
npm run build
npm run test:run
```

Then repeat the valid and invalid API requests.

Do not move to the next lecture until the build, tests, and manual checks pass.

---

## 11. Failure Scenarios and Production Trade-offs

### 11.1 Bulk enqueue is not batch completion

A batch request can be accepted while jobs remain in the waiting state.

If clients need to know when the batch finishes, a future design should persist a batch record and track each job's terminal state.

Returning job IDs is useful, but it is not a complete batch-status system.

### 11.2 Bulk enqueue is not a cross-system transaction

Suppose a future workflow must:

1. Insert an incident into PostgreSQL.
2. Enqueue an analysis job in Redis.
3. Notify another service.

These operations do not automatically form one atomic transaction.

For reliable database-to-queue delivery, we will later examine patterns such as the transactional outbox.

### 11.3 Partial results need an explicit policy

Our service returns a result only after `addBulk()` resolves. It does not implement per-item recovery or a durable record of which items were submitted.

If a production requirement demands individual outcome tracking, design that behavior explicitly rather than assuming bulk enqueue provides it.

### 11.4 Choose a sensible batch size

A batch size of 100 is a starting point.

The right value depends on:

- Job payload size.
- Redis memory and latency.
- API request limits.
- Worker processing time.
- Retry behavior.
- Maximum acceptable queue growth.
- Whether the batch is submitted by an interactive user or a scheduled process.

A batch of 100 tiny tasks is very different from a batch of 100 large payloads.

### 11.5 Do not confuse bulk enqueue with rate limiting

`addBulk()` reduces enqueue overhead. It does not make external APIs process jobs faster and does not bypass your existing worker rate limiter.

The external API queue and its rate-limiting configuration remain separate from this demonstration.

### 11.6 Retries can duplicate side effects

BullMQ retries may cause a job to execute more than once.

If a job sends a notification, updates an incident, or calls an external API, consider idempotency and safe retry design. We will explore those concepts in more depth in later lectures.

---

## 12. Final Folder Structure

After this lecture, the relevant additions should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── routes/
│   │   └── batch.routes.ts                 [NEW]
│   ├── services/
│   │   └── batch-enqueue.service.ts        [NEW]
│   ├── queues/
│   │   ├── demo.queue.ts                   [UNCHANGED]
│   │   └── jobs/
│   │       └── demo.job.ts                 [UNCHANGED]
│   ├── workers/
│   │   └── demo.worker.ts                  [UNCHANGED]
│   ├── app.ts                              [MODIFIED]
│   └── workers.ts                          [UNCHANGED]
└── tests/
    └── batch-enqueue.service.test.ts       [NEW]
```

This is a view of the files relevant to this lecture, not the complete project structure.

---

## 13. Success Criteria

Before moving forward, confirm each item.

- [ ] `src/services/batch-enqueue.service.ts` exists.
- [ ] `src/routes/batch.routes.ts` exists.
- [ ] The route is registered in `src/app.ts`.
- [ ] The endpoint accepts valid batches.
- [ ] Valid batches are submitted using one `addBulk()` call.
- [ ] The response includes the count and returned job IDs.
- [ ] Empty batches are rejected.
- [ ] Blank messages are rejected.
- [ ] Messages longer than 500 characters are rejected.
- [ ] Batches larger than 100 items are rejected.
- [ ] Enqueue errors propagate to error handling.
- [ ] The existing demo worker processes submitted jobs.
- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes.
- [ ] The intentional-break exercises have been fixed and re-tested.

### What you learned

You now know how to submit a bounded collection of independent jobs using BullMQ's bulk API while preserving your existing queue and worker architecture.

**Next lecture — Module 2, Lecture 18: Parent–Child Jobs and Advanced Batch Orchestration.** We'll move beyond independent jobs and explore how one parent job can coordinate multiple child jobs and collect their results.