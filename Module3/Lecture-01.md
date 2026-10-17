# Module 3 — Lecture 1: At-Least-Once vs. Exactly-Once Processing

## Table of Contents

1. Learning Objectives
2. The Distributed Systems Problem
3. At-Most-Once, At-Least-Once, and Exactly-Once
4. Why Retries Can Create Duplicate Effects
5. Idempotency: The Practical Solution
6. Architecture
7. Create the Database Migration
8. Implement the Idempotent Service
9. Implement the BullMQ Worker
10. Create the Queue and Producer
11. Create the API Route
12. Register the Route
13. Integrate Worker Lifecycle
14. Tests and Verification
15. Intentional Break → Understand → Fix
16. Production Trade-offs
17. Final Folder Structure
18. Success Criteria

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- The difference between at-most-once and at-least-once processing.
- Why exactly-once execution is difficult in distributed systems.
- How retries can execute a job more than once.
- Why a successful business operation and successful job acknowledgment are separate events.
- How idempotency keys prevent duplicate database effects.
- How to combine a PostgreSQL transaction with an idempotency record.
- How BullMQ retry behavior interacts with database transactions.
- Why a unique constraint is stronger than an in-memory `Map`.
- How to test duplicate delivery and conflicting requests.

We will use your existing stack:

- Node.js
- TypeScript
- Express
- PostgreSQL
- BullMQ
- Redis
- Docker Compose

We will not introduce AI or another database.

## 2. The Distributed Systems Problem

Imagine the platform receives a job to record an incident-processing effect.

The worker performs these operations:

1. Receives the job from BullMQ.
2. Inserts a record into PostgreSQL.
3. PostgreSQL commits the transaction.
4. The worker crashes before BullMQ records the job as completed.

From BullMQ's perspective, the job may not have completed successfully.

When the job is retried, the worker may attempt the database operation again.

The sequence looks like this:

```text
BullMQ
   |
   | Deliver job
   v
Worker
   |
   | INSERT business effect
   v
PostgreSQL
   |
   | COMMIT succeeds
   v
Worker crashes
   |
   | BullMQ has not recorded completion
   v
Job is retried
   |
   v
Worker receives the same logical operation again
```

The critical question is:

**How do we prevent the same logical operation from producing a duplicate business effect?**

The solution is not simply to disable retries. A job can fail because of a temporary network problem, a worker crash, or a transient dependency failure.

We need to design the operation so that repeated execution is safe.

---

## 3. At-Most-Once, At-Least-Once, and Exactly-Once

### 3.1 At-most-once processing

An operation is attempted no more than once.

This avoids repeated execution, but a failure may mean the operation is never completed.

For example, a message could be lost after delivery if the system does not retry it.

**Trade-off:** fewer duplicates, but potentially lost work.

### 3.2 At-least-once processing

The system retries work until it succeeds or reaches its retry policy's terminal state.

A job may execute more than once.

BullMQ supports retry behavior through options such as:

```ts
{
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000
  }
}
```

This configuration allows up to three processing attempts, including the initial attempt.

**Trade-off:** better recovery from transient failures, but duplicate execution must be expected.

### 3.3 Exactly-once processing

The phrase "exactly once" can mean several different things.

We must distinguish:

- A job being delivered exactly once.
- A worker's processor function executing exactly once.
- A database effect being committed exactly once.
- An external API receiving an operation exactly once.
- An event being observed exactly once by every consumer.

These are not equivalent guarantees.

In distributed systems, failures can occur between any two operations. There is generally no way to guarantee that arbitrary code executes exactly once across independent systems simply by adding retries or acknowledgments.

A more practical design is:

> Allow repeated delivery, but make the business effect idempotent and enforce the necessary uniqueness atomically.

For our example, repeated processing may happen, but PostgreSQL will commit at most one business effect for a given idempotency key.

---

## 4. Why Retries Can Create Duplicate Effects

Consider a payment-like operation:

```text
Operation: Record payment of ₹1,000
```

If a worker executes it twice without protection, the database might record two payment entries.

The problem is not that retries are inherently incorrect. The problem is that the operation has no protection against duplicate execution.

### A dangerous implementation

```ts
await pool.query(
  `INSERT INTO business_effects (message)
   VALUES ($1)`,
  [message]
);
```

If the same logical operation runs twice, this statement can insert two rows.

### Why an in-memory `Map` is insufficient

You might try:

```ts
const processed = new Map<string, boolean>();
```

This fails under common production conditions:

- The process can restart.
- Multiple worker processes have separate memory.
- A container can be replaced.
- A retry can be processed by another worker.
- Two workers can check the map simultaneously.

Idempotency must be enforced by a shared, durable system.

For this lecture, PostgreSQL will enforce the idempotency key with a unique constraint.

---

## 5. Idempotency: The Practical Solution

An operation is idempotent if repeating it with the same logical input produces the same final effect as performing it once.

For example:

```text
First request:
idempotencyKey = incident-123
message = "Record incident"

Result:
One business effect is committed.
```

The same request arrives again:

```text
Second request:
idempotencyKey = incident-123
message = "Record incident"

Result:
The existing effect is returned.
No second business effect is committed.
```

But suppose the same key is reused for different data:

```text
First request:
idempotencyKey = incident-123
message = "Record incident"

Second request:
idempotencyKey = incident-123
message = "Delete incident"
```

This should not silently return the result of the first request. It should be rejected as a conflicting reuse of the key.

We will implement both protections.

### Our database invariant

For a given idempotency key:

1. Only one effect record can be committed.
2. Repeated requests with the same payload return the stored result.
3. Reusing the key with a different payload is rejected.
4. The idempotency record and business effect are committed in the same PostgreSQL transaction.

The fourth condition is especially important. It prevents a crash from leaving a committed idempotency record without its corresponding business effect.

---

## 6. Architecture

```text
HTTP Client
    |
    v
POST /demo/idempotency
    |
    v
Validate Request
    |
    v
BullMQ Producer
    |
    v
Redis Queue
    |
    v
Idempotency Worker
    |
    v
PostgreSQL Transaction
    |
    +--------------------------+
    |                          |
    v                          v
Idempotency Record       Business Effect
    |                          |
    +-------------+------------+
                  |
                  v
              COMMIT
                  |
                  v
          BullMQ Job Completes
```

If the worker crashes after PostgreSQL commits but before BullMQ records completion, a retry can execute the transaction again.

The second attempt finds the existing idempotency record, verifies the payload, and returns the previously stored result.

It does not insert a second business effect.

### Files to create

| Action | File |
|---|---|
| Create | `src/database/migrations/20261016_create_idempotency_effects.sql` |
| Create | `src/queues/jobs/idempotency.job.ts` |
| Create | `src/queues/idempotency.queue.ts` |
| Create | `src/queues/producers/idempotency.producer.ts` |
| Create | `src/services/idempotent-effect.service.ts` |
| Create | `src/workers/idempotency.worker.ts` |
| Create | `src/routes/idempotency.routes.ts` |
| Create | `tests/idempotent-effect.service.test.ts` |
| Modify | `src/app.ts` |
| Modify | `src/workers.ts` |

**Migration note:** If your migration directory already contains a file with the proposed name, use the next unique migration filename according to your project's existing naming convention. Do not overwrite an existing migration.

---

## 7. Create the Database Migration

**File: `src/database/migrations/20261016_create_idempotency_effects.sql`**

**Action: CREATE a new migration file.**

```sql
CREATE TABLE IF NOT EXISTS idempotency_effects (
    idempotency_key TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_effects (
    effect_id UUID PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE
        REFERENCES idempotency_effects(idempotency_key),
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_effects_created_at
    ON business_effects (created_at);
```

### Understand the schema

#### `idempotency_effects`

This table stores the result associated with a logical operation.

- `idempotency_key` is the primary key.
- `payload_hash` identifies the normalized request payload.
- `result` stores the result returned by the original successful operation.
- `created_at` records when the operation was committed.

#### `business_effects`

This table represents the business effect we want to commit only once.

The unique constraint on `idempotency_key` is an additional safeguard against duplicate effects.

The `effect_id` is generated by the application, avoiding a dependency on PostgreSQL UUID-generation extensions.

### Why use two tables?

The idempotency record represents the identity and stored result of an operation.

The business-effect table represents the effect itself.

Both are written in the same transaction, so they either commit together or roll back together.

### Run the migration

Your project already has a migration runner at `src/database/migrate.ts`.

First, inspect that runner and confirm its expected migration filename format and discovery rules.

If it supports this SQL migration, run:

**Terminal: PowerShell**

```powershell
npm run migrate
```

If your runner requires a particular filename convention, rename the new migration to follow that convention before running it.

Do not assume a migration succeeded merely because the command started. Verify the result.

### Verify the tables

Use your existing PostgreSQL connection or `psql`:

**Terminal: PowerShell**

```powershell
docker compose exec postgres psql -U postgres -d production_intelligence
```

If your Compose service has a different name, use the service name from your actual `docker-compose.yml`.

Inside `psql`:

```sql
\d idempotency_effects
\d business_effects
```

Expected: both tables exist with their primary keys and constraints.

Exit `psql`:

```sql
\q
```

---

## 8. Implement the Idempotent Service

**File: `src/services/idempotent-effect.service.ts`**

**Action: CREATE this file.**

```ts
import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "../database/pool.js";

export interface IdempotentEffectInput {
  idempotencyKey: string;
  message: string;
}

export interface IdempotentEffectResult {
  effectId: string;
  idempotencyKey: string;
  message: string;
  created: boolean;
}

interface StoredResult {
  effectId: string;
  idempotencyKey: string;
  message: string;
}

const MAX_KEY_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;

const validateInput = (
  input: IdempotentEffectInput
): void => {
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0 ||
    input.idempotencyKey.length > MAX_KEY_LENGTH
  ) {
    throw new TypeError(
      `Idempotency key must contain 1 to ${MAX_KEY_LENGTH} characters`
    );
  }

  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError(
      `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
    );
  }
};

const hashPayload = (message: string): string => {
  return createHash("sha256")
    .update(JSON.stringify({ message }))
    .digest("hex");
};

export const recordIdempotentEffect = async (
  input: IdempotentEffectInput
): Promise<IdempotentEffectResult> => {
  validateInput(input);

  const idempotencyKey = input.idempotencyKey.trim();
  const message = input.message.trim();
  const payloadHash = hashPayload(message);

  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const insertRecord = await client.query(
      `
        INSERT INTO idempotency_effects (
          idempotency_key,
          payload_hash,
          result
        )
        VALUES ($1, $2, '{}'::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `,
      [idempotencyKey, payloadHash]
    );

    if (insertRecord.rowCount === 0) {
      const existingRecord = await client.query<{
        payload_hash: string;
        result: StoredResult;
      }>(
        `
          SELECT payload_hash, result
          FROM idempotency_effects
          WHERE idempotency_key = $1
        `,
        [idempotencyKey]
      );

      const existing = existingRecord.rows[0];

      if (!existing) {
        throw new Error(
          "Idempotency record was not found after conflict"
        );
      }

      if (existing.payload_hash !== payloadHash) {
        throw new Error(
          "Idempotency key was reused with a different payload"
        );
      }

      const storedResult = existing.result;

      await client.query("COMMIT");

      return {
        ...storedResult,
        created: false
      };
    }

    const effectId = randomUUID();

    await client.query(
      `
        INSERT INTO business_effects (
          effect_id,
          idempotency_key,
          message
        )
        VALUES ($1, $2, $3)
      `,
      [effectId, idempotencyKey, message]
    );

    const result: StoredResult = {
      effectId,
      idempotencyKey,
      message
    };

    await client.query(
      `
        UPDATE idempotency_effects
        SET result = $2::jsonb
        WHERE idempotency_key = $1
      `,
      [idempotencyKey, JSON.stringify(result)]
    );

    await client.query("COMMIT");

    return {
      ...result,
      created: true
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }

    throw error;
  } finally {
    client.release();
  }
};
```

### Understand the transaction

The service performs these operations:

1. Validates the request.
2. Normalizes the key and message.
3. Computes a SHA-256 payload hash.
4. Begins a PostgreSQL transaction.
5. Attempts to insert the idempotency record.
6. If the key already exists, verifies the payload and returns the stored result.
7. Otherwise, inserts the business effect.
8. Stores the result in the idempotency record.
9. Commits both writes together.

### Why `ON CONFLICT DO NOTHING`?

Two workers can receive the same logical request concurrently.

Both may attempt to insert the same idempotency key.

The primary key ensures that only one insert wins. PostgreSQL's unique constraint coordinates the competing transactions.

The losing transaction then reads the existing record and checks whether the payload matches.

This is safer than performing a separate `SELECT` followed by an `INSERT` without a database constraint.

### Why use a payload hash?

The key identifies the logical operation.

The payload hash ensures that the same key is not silently reused for a different operation.

For this lecture, the payload is a normalized message. In a real application, include every field that materially changes the business operation.

### Why store the result?

When a duplicate request arrives, returning the original result gives the caller a stable response.

It avoids generating a new effect identifier or creating another business effect.

### Why keep the writes in one transaction?

Consider a crash after the business-effect insert but before the idempotency record is finalized.

Because both operations are in the same transaction, PostgreSQL can roll back both if the transaction has not committed.

This prevents an orphaned idempotency record from being committed independently of the business effect.

### A note about concurrency

The unique constraint coordinates concurrent inserts. A transaction that encounters a conflicting insert may wait for the competing transaction to commit or roll back.

If the first transaction commits, the duplicate can read the committed result. If the first transaction rolls back, the second attempt can proceed with its own insert.

This is the database-level protection we need.

---

## 9. Implement the BullMQ Worker

**File: `src/queues/jobs/idempotency.job.ts`**

**Action: CREATE this file.**

```ts
export interface IdempotencyJobData {
  idempotencyKey: string;
  message: string;
}
```

**File: `src/queues/idempotency.queue.ts`**

**Action: CREATE this file.**

```ts
import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import type {
  IdempotencyJobData
} from "./jobs/idempotency.job.js";

import type {
  IdempotentEffectResult
} from "../services/idempotent-effect.service.js";

export const IDEMPOTENCY_QUEUE_NAME =
  "idempotency-demo";

export const idempotencyQueue = new Queue<
  IdempotencyJobData,
  IdempotentEffectResult
>(
  IDEMPOTENCY_QUEUE_NAME,
  {
    connection: createBullMQConnection(1),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export const waitForIdempotencyQueueReady =
  async (): Promise<void> => {
    await idempotencyQueue.waitUntilReady();
  };

export const closeIdempotencyQueue =
  async (): Promise<void> => {
    await idempotencyQueue.close();
  };
```

### Important import note

If your project prefers a strict separation between queue types and service types, move `IdempotentEffectResult` into a dedicated shared type file.

For this lecture, the import is type-only and does not load the service at runtime.

**File: `src/queues/producers/idempotency.producer.ts`**

**Action: CREATE this file.**

```ts
import { idempotencyQueue } from "../idempotency.queue.js";

import type {
  IdempotencyJobData
} from "../jobs/idempotency.job.js";

export const enqueueIdempotencyJob = async (
  data: IdempotencyJobData
): Promise<string> => {
  const job = await idempotencyQueue.add(
    "record-idempotent-effect",
    data
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return job.id;
};
```

### Why not use the idempotency key as the only protection?

We could supply a deterministic BullMQ `jobId` derived from the idempotency key.

That can reduce duplicate job creation while a corresponding job remains in Redis.

However, BullMQ job-ID deduplication is not a permanent business guarantee. If the original job is removed according to the retention policy, another job with the same ID may later be accepted.

It also does not make an external side effect atomic with BullMQ acknowledgment.

Our database constraint is the durable protection for the business effect.

**File: `src/workers/idempotency.worker.ts`**

**Action: CREATE this file.**

```ts
import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  IDEMPOTENCY_QUEUE_NAME
} from "../queues/idempotency.queue.js";

import type {
  IdempotencyJobData
} from "../queues/jobs/idempotency.job.js";

import type {
  IdempotentEffectResult
} from "../services/idempotent-effect.service.js";

import {
  recordIdempotentEffect
} from "../services/idempotent-effect.service.js";

import { logger } from "../logging/logger.js";

export const idempotencyWorker =
  new Worker<
    IdempotencyJobData,
    IdempotentEffectResult
  >(
    IDEMPOTENCY_QUEUE_NAME,
    async (job) => {
      const result = await recordIdempotentEffect({
        idempotencyKey: job.data.idempotencyKey,
        message: job.data.message
      });

      logger.info("Idempotency job processed", {
        jobId: job.id,
        idempotencyKey: result.idempotencyKey,
        effectId: result.effectId,
        created: result.created
      });

      return result;
    },
    {
      connection: createBullMQConnection(1),
      concurrency: 5
    }
  );
```

### Understand the worker

The worker calls the idempotent service.

If BullMQ retries the same job, the service runs again. The database transaction decides whether a new business effect should be created.

A duplicate execution returns the existing result with `created: false`.

This is the key property: **the worker may execute repeatedly while the database effect remains unique.**

---

## 10. Create the API Route

**File: `src/routes/idempotency.routes.ts`**

**Action: CREATE this file.**

```ts
import { Router } from "express";

import {
  enqueueIdempotencyJob
} from "../queues/producers/idempotency.producer.js";

export const idempotencyRoutes = Router();

const MAX_KEY_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;

idempotencyRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const idempotencyKey: unknown =
        req.body?.idempotencyKey;

      const message: unknown =
        req.body?.message;

      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.trim().length === 0 ||
        idempotencyKey.length > MAX_KEY_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_IDEMPOTENCY_KEY",
            message:
              `idempotencyKey must contain 1 to ${MAX_KEY_LENGTH} characters`
          }
        });
        return;
      }

      if (
        typeof message !== "string" ||
        message.trim().length === 0 ||
        message.length > MAX_MESSAGE_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
          }
        });
        return;
      }

      const jobId = await enqueueIdempotencyJob({
        idempotencyKey: idempotencyKey.trim(),
        message: message.trim()
      });

      res.status(202).json({
        success: true,
        data: {
          jobId,
          idempotencyKey: idempotencyKey.trim(),
          state: "accepted"
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
```

### Endpoint

```text
POST /demo/idempotency
```

Example body:

```json
{
  "idempotencyKey": "incident-123",
  "message": "Record incident processing"
}
```

The endpoint returns `202 Accepted` because the work is asynchronous.

The initial response does not prove that the database effect has been committed.

The queue may retry the job, and the worker may process it later.

---

## 11. Register the Route

**File: `src/app.ts`**

**Action: MODIFY this file. Do not replace the entire application file.**

### Step 1: Add the import

```ts
import {
  idempotencyRoutes
} from "./routes/idempotency.routes.js";
```

### Step 2: Register the route

```ts
app.use(
  "/demo/idempotency",
  idempotencyRoutes
);
```

Preserve your existing middleware and route order:

1. JSON parsing.
2. Existing request ID, logging, and security middleware.
3. Application routes.
4. Not-found middleware.
5. Error middleware.

Do not duplicate existing middleware or remove unrelated routes.

---

## 12. Integrate Worker Lifecycle

Your existing `src/workers.ts` manages the demo, external API, fan-out, pipeline, parent–child, workload, and sharded workers.

Add the new idempotency worker to that same lifecycle.

### 12.1 Add imports

**File: `src/workers.ts`**

**Action: MODIFY this file. Add these imports alongside your existing worker and queue imports.**

```ts
import {
  idempotencyWorker
} from "./workers/idempotency.worker.js";

import {
  closeIdempotencyQueue,
  waitForIdempotencyQueueReady
} from "./queues/idempotency.queue.js";
```

### 12.2 Add readiness checks

Inside the existing `start()` function, add the following after your existing queue readiness checks.

**File: `src/workers.ts`**

**Action: MODIFY the existing `start()` function.**

```ts
await waitForIdempotencyQueueReady();
await idempotencyWorker.waitUntilReady();
```

Do not create a second startup function.

### 12.3 Add startup failure cleanup

Your existing startup failure path uses `Promise.allSettled()`.

Add the new worker and queue cleanup to the existing cleanup array.

**File: `src/workers.ts`**

**Action: MODIFY the existing startup failure cleanup array.**

```ts
idempotencyWorker.close(),
closeIdempotencyQueue()
```

Keep all existing cleanup entries.

### 12.4 Add graceful shutdown

Add the worker to the existing worker-close operation.

**File: `src/workers.ts`**

**Action: MODIFY the existing worker-close array.**

```ts
idempotencyWorker.close()
```

Then add queue cleanup to the existing shutdown sequence, after the workers have been closed.

**File: `src/workers.ts`**

**Action: MODIFY the existing shutdown sequence.**

```ts
await closeIdempotencyQueue();
```

Preserve your existing shutdown guard, logging, error handling, and cleanup of all previously registered workers and queues.

Do not close the same queue twice in the same cleanup path.

---

## 13. Tests and Verification

We need to test both the service logic and the real PostgreSQL constraint.

A mocked unit test can verify input validation, but it cannot prove that PostgreSQL correctly handles concurrent transactions. We will distinguish the two levels of verification.

### 13.1 Test service input validation

**File: `tests/idempotent-effect.service.test.ts`**

**Action: CREATE this file.**

```ts
import {
  describe,
  expect,
  it
} from "vitest";

import {
  recordIdempotentEffect
} from "../src/services/idempotent-effect.service.js";

describe("recordIdempotentEffect input validation", () => {
  it("rejects an empty idempotency key", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "   ",
        message: "Record incident"
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects an empty message", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "incident-123",
        message: "   "
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects an idempotency key over 200 characters", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "k".repeat(201),
        message: "Record incident"
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects a message over 500 characters", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "incident-123",
        message: "m".repeat(501)
      })
    ).rejects.toThrow(TypeError);
  });
});
```

These tests fail before the service obtains a PostgreSQL connection.

They do not require Redis or PostgreSQL to be running.

### 13.2 Run the targeted tests

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/idempotent-effect.service.test.ts
```

Expected: all four validation tests pass.

### 13.3 Build the project

**Terminal: PowerShell**

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

If the migration runner uses a different naming convention, resolve that before continuing with database verification.

### 13.4 Start the API and worker

**Terminal 1: PowerShell**

```powershell
npm run dev
```

**Terminal 2: PowerShell**

```powershell
npm run dev:worker
```

Confirm that both processes start without errors.

### 13.5 Submit the first request

**Terminal: PowerShell**

```powershell
$body = @{
    idempotencyKey = "incident-123"
    message = "Record incident processing"
} | ConvertTo-Json

$response1 = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/idempotency" `
    -ContentType "application/json" `
    -Body $body

$response1
```

Expected: HTTP `202 Accepted` and a BullMQ job ID.

### 13.6 Submit the same logical request again

**Terminal: PowerShell**

```powershell
$body = @{
    idempotencyKey = "incident-123"
    message = "Record incident processing"
} | ConvertTo-Json

$response2 = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/idempotency" `
    -ContentType "application/json" `
    -Body $body

$response2
```

The second request may create a second BullMQ job. That is acceptable for this demonstration.

The important property is that both jobs use the same idempotency key and the same normalized payload.

When both jobs have been processed, the database should contain only one business effect for `incident-123`.

### 13.7 Verify the database

Connect to PostgreSQL using your actual Compose service name.

**Terminal: PowerShell**

```powershell
docker compose exec postgres psql -U postgres -d production_intelligence
```

Inside `psql`:

```sql
SELECT
    idempotency_key,
    payload_hash,
    result,
    created_at
FROM idempotency_effects
WHERE idempotency_key = 'incident-123';
```

Expected: one idempotency record.

Now inspect the business effects:

```sql
SELECT
    effect_id,
    idempotency_key,
    message,
    created_at
FROM business_effects
WHERE idempotency_key = 'incident-123';
```

Expected: exactly one business-effect row.

Exit `psql`:

```sql
\q
```

### 13.8 Verify conflicting payloads

Submit a request using the same key but a different message.

**Terminal: PowerShell**

```powershell
$body = @{
    idempotencyKey = "incident-123"
    message = "Different business operation"
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/idempotency" `
    -ContentType "application/json" `
    -Body $body
```

The API may still return `202 Accepted` because it has only submitted the job.

When the worker processes it, the service will reject the conflicting payload. BullMQ will retry according to the configured retry policy and eventually mark the job failed if the conflict persists.

This highlights an important distinction: request acceptance is not the same as business-operation success.

---

## 14. Intentional Break → Understand → Fix

### Break 1: Remove the database uniqueness constraint

**File: `src/database/migrations/20261016_create_idempotency_effects.sql`**

In a disposable development database only, temporarily remove the unique constraint on `business_effects.idempotency_key` from a test copy of the schema.

Do not alter production schema to perform this exercise.

The idempotency table's primary key still protects the normal transaction path, so the duplicate effect may not immediately appear. This demonstrates that the service's logic and the database constraints work together.

A stronger way to expose the weakness is to bypass the idempotent service and directly insert multiple business-effect rows for the same key.

**SQL — run only in a disposable test database.**

```sql
INSERT INTO business_effects (
    effect_id,
    idempotency_key,
    message
)
VALUES (
    gen_random_uuid(),
    'incident-123',
    'Duplicate effect'
);
```

This example uses `gen_random_uuid()`, which may not be available unless the PostgreSQL version and extensions support it. If unavailable, supply a UUID generated by your application instead.

With the unique constraint intact, the insert should fail because `incident-123` already exists.

### Understand the failure

Application-level checks are not sufficient by themselves.

Another process, a script, or a future code path might write directly to the table.

The database constraint protects the invariant across all writers.

### Fix 1

Keep the unique constraint on `business_effects.idempotency_key`.

Restore the original migration in your source tree. Do not edit an already-applied production migration to remove or add constraints; use a new migration for real schema changes.

### Break 2: Commit the business effect separately

**File: `src/services/idempotent-effect.service.ts`**

For this conceptual exercise, imagine the business-effect insert is committed independently before the idempotency record is finalized.

A crash between those operations can leave an inconsistent state.

Depending on the exact sequence, a retry may find a business effect without a matching idempotency record and attempt the effect again.

The unique constraint may reject the duplicate, but the operation's recovery path would now be more complicated.

### Understand the failure

The idempotency record and the business effect must share one transaction when they belong to the same PostgreSQL consistency boundary.

That is what lets PostgreSQL commit both or roll both back.

### Fix 2

Restore the single-transaction implementation:

1. `BEGIN`.
2. Insert or check the idempotency record.
3. Insert the business effect if the key is new.
4. Store the result.
5. `COMMIT`.

### Final verification

**Terminal: PowerShell**

```powershell
npm run build
npm run test:run
```

Then repeat the duplicate-request verification against PostgreSQL.

Expected: one idempotency record and one business-effect record for the same key and payload.

---

## 15. Production Trade-offs

### 15.1 This does not make the worker execute exactly once

The worker can execute multiple times.

The database transaction ensures that this particular business effect is created at most once per idempotency key.

That is a more precise and useful guarantee than claiming that the processor executes exactly once.

### 15.2 External API calls are different

Suppose the worker sends an email or calls an external payment API.

A PostgreSQL transaction cannot atomically commit a database record and guarantee that the external service performed its action exactly once.

If the external service supports idempotency keys, use them.

If it does not, the integration needs a separate recovery and reconciliation strategy.

### 15.3 Idempotency keys need a lifecycle

The idempotency record is part of the correctness guarantee.

Deleting it too early can allow an old operation to be repeated.

Retention policies should be based on the business requirement, not simply on database size.

### 15.4 A payload hash is not a security mechanism

The SHA-256 hash detects whether the normalized payload differs.

It does not authenticate the caller, authorize the operation, or prove that the payload is trustworthy.

Authentication and authorization must remain separate concerns.

### 15.5 Database errors need classification

Not every error should be retried indefinitely.

Examples:

- Temporary database connectivity problems may be retryable.
- A conflicting idempotency key is a permanent business validation failure.
- A malformed payload should be rejected before enqueueing.
- A schema mismatch may require an operational intervention.

The example uses a generic error for a conflict, so BullMQ will retry it. That is acceptable for observing the retry behavior, but inefficient for production.

A production implementation should classify permanent business errors and avoid repeatedly retrying them.

### 15.6 The queue and database are separate systems

The API first enqueues a job in Redis. The worker later commits a database transaction.

These operations are not one atomic transaction.

If you need reliable coordination between PostgreSQL business writes and queue publication, the transactional outbox pattern is a common solution. We will cover it later in this module.

### 15.7 BullMQ job IDs are not permanent idempotency records

BullMQ can suppress duplicate job additions while a matching job ID exists, depending on the queue's state and retention behavior.

That does not replace durable database idempotency for business effects.

A retained queue job and a committed business transaction have different lifecycles.

---

## 16. Final Folder Structure

The following is a focused view of the files introduced in this lecture.

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/
│   │   │   └── 20261016_create_idempotency_effects.sql
│   │   └── pool.ts
│   ├── queues/
│   │   ├── jobs/
│   │   │   └── idempotency.job.ts
│   │   ├── idempotency.queue.ts
│   │   └── producers/
│   │       └── idempotency.producer.ts
│   ├── services/
│   │   └── idempotent-effect.service.ts
│   ├── workers/
│   │   └── idempotency.worker.ts
│   ├── routes/
│   │   └── idempotency.routes.ts
│   ├── app.ts
│   └── workers.ts
└── tests/
    └── idempotent-effect.service.test.ts
```

Your existing project files remain in place.

---

## 17. Success Criteria

Before moving forward, verify every item.

- [ ] You can explain at-most-once and at-least-once processing.
- [ ] You understand why worker retries can execute a processor more than once.
- [ ] The idempotency and business-effect tables exist.
- [ ] The idempotency key is protected by a primary key.
- [ ] The business effect has a unique constraint on the idempotency key.
- [ ] The service stores the idempotency record and business effect in one transaction.
- [ ] Duplicate requests with the same key and payload return the stored result.
- [ ] Reusing a key with a different payload is rejected.
- [ ] The new queue participates in worker readiness checks.
- [ ] The new worker participates in startup failure cleanup.
- [ ] The new worker and queue participate in graceful shutdown.
- [ ] Validation tests pass.
- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes.
- [ ] Repeated submissions create only one business-effect row.
- [ ] You have verified the result directly in PostgreSQL.

---

## 18. What You Learned

You have examined one of the most important distributed-systems failure modes: the business operation succeeds, but the worker cannot reliably communicate that success to the queue.

The correct response is not to assume that retries will never duplicate execution.

Instead, design the business effect to tolerate repeated delivery and enforce its invariants in a durable system.

For this example, PostgreSQL provides the uniqueness guarantee and transaction boundary.

**Key takeaway: At-least-once delivery plus durable idempotency can provide an effectively-once database effect for a defined operation and idempotency key. It does not make arbitrary distributed side effects exactly once.**

### Next lecture — Module 3, Lecture 2: Distributed Locks

We will examine how multiple workers can race to modify the same resource, why a database transaction alone does not always solve coordination problems, and when a distributed lock is appropriate.