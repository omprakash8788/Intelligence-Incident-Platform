
# Module 3 — Distributed Systems
# Lecture 15: Idempotency Under Retries and Concurrent Execution

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [The Duplicate-Execution Problem](#2-the-duplicate-execution-problem)
3. [What Idempotency Means](#3-what-idempotency-means)
4. [Designing an Idempotency Record](#4-designing-an-idempotency-record)
5. [Database Migration](#5-database-migration)
6. [Implement the Idempotency Service](#6-implement-the-idempotency-service)
7. [How Concurrent Requests Are Handled](#7-how-concurrent-requests-are-handled)
8. [Write Integration Tests](#8-write-integration-tests)
9. [Run and Verify the Tests](#9-run-and-verify-the-tests)
10. [Intentionally Break the Implementation](#10-intentionally-break-the-implementation)
11. [Build and Verification](#11-build-and-verification)
12. [Production Limitations](#12-production-limitations)
13. [Final Folder Structure](#13-final-folder-structure)
14. [Success Criteria](#14-success-criteria)
15. [Next Lecture](#15-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why BullMQ retries can cause the same logical operation to execute more than once.
- How idempotency keys identify logical operations.
- Why a PostgreSQL unique constraint is necessary for concurrency safety.
- How to store a successful result so a retry can reuse it.
- How to reject reuse of the same key with a different request.
- Why the business database change and idempotency record must commit in the same transaction.
- Why a database transaction cannot make an external HTTP request exactly once.

**Scope:** This is an isolated PostgreSQL exercise. We will create a migration under your existing `src/database/migrations/` directory and add a service plus integration tests. We will not modify `src/workers.ts` or wire the service into BullMQ yet.

## 2. The Duplicate-Execution Problem

Imagine a background job that charges a customer.

1. The worker sends a charge request.
2. The payment provider processes the charge.
3. The worker crashes before recording success.
4. BullMQ retries the job.
5. The worker sends the same charge request again.

Without an idempotency mechanism, the customer may be charged twice.

The same problem occurs with:

- Creating orders.
- Issuing refunds.
- Sending notifications.
- Updating account balances.
- Processing uploaded files.
- Triggering external API operations.

A retry is not necessarily a new business operation. It may be another attempt to complete the same logical operation.

### The important distinction

```text
Logical operation: Create order 123

Attempt 1 -> database commits -> response is lost
Attempt 2 -> same logical operation is retried
```

The second attempt should retrieve or reproduce the original successful result, not apply the business effect again.

## 3. What Idempotency Means

An operation is idempotent when repeating the same logical request does not produce additional effects beyond the first successful execution.

For this lecture, each operation has:

- An `idempotencyKey` that identifies the logical operation.
- A `requestHash` that identifies the request's meaningful input.
- A stored result that can be returned to a retry.

Example:

```text
idempotencyKey = create-order:customer-100:request-abc
requestHash    = hash of the order request
```

The rules are:

| Situation | Expected behavior |
|---|---|
| First request with a new key | Execute the operation and store its result |
| Retry with the same key and same request | Return the stored result |
| Same key with different request input | Reject the request |
| First attempt fails and transaction rolls back | Permit a later retry to attempt the operation |
| Two attempts arrive concurrently with the same key | Only one transaction executes the database operation |

### Important distinction: key vs. request hash

The key identifies the operation. The hash checks whether a later request is genuinely the same request.

Never silently treat two different requests as identical just because they use the same idempotency key.

## 4. Designing an Idempotency Record

We will create a table with these fields:

| Column | Purpose |
|---|---|
| `idempotency_key` | Unique identifier for the logical operation |
| `request_hash` | Detects accidental or malicious key reuse |
| `response` | Stores the successful result |
| `created_at` | Records when the operation was created |

The table will not use a persistent `in_progress` record in this design. The record is inserted, the business operation runs, and the response is saved in the same transaction.

This is deliberate.

If the transaction fails, PostgreSQL rolls back the idempotency record and the business changes together. A retry can attempt the operation again.

If the transaction commits, both the business changes and the stored result are durable.

## 5. Database Migration

### Step 1 — Inspect your existing migration sequence

Your project uses:

`src/database/migrations/`

Before creating a migration, inspect the existing files and identify the next sequence number.

Do not create a root-level `database/` directory, and do not reuse a migration number.

Also check whether an existing migration already defines an equivalent idempotency table. If it does, do not create a duplicate table; adapt the service to the existing schema.

### Step 2 — Create the next migration

**File: `src/database/migrations/NNN_idempotency_records.sql`**

Replace `NNN` with the next unused number in your existing migration sequence. For example, if the highest existing migration is `024`, use `025` only if that is the correct next number in your repository.

Create the migration with this complete SQL:

```sql
CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
```

The primary key guarantees that PostgreSQL cannot store two rows with the same idempotency key.

**Do not execute this migration manually if your project's migration runner manages schema changes.** Use the existing migration process and verify the table was created.

This migration is additive. It does not replace or modify any existing migrations.

## 6. Implement the Idempotency Service

### Step 1 — Create the service file

**File: `src/services/idempotency.service.ts`**

Create this file with the complete code below.

It uses the `pg` pool export convention used elsewhere in this course. If your actual `src/database/pool.ts` exports a differently named pool, match the existing export instead of modifying the pool configuration.

```typescript
import type {
  PoolClient
} from "pg";

import { pool } from "../database/pool.js";

export interface IdempotencyInput {
  idempotencyKey: string;
  requestHash: string;
}

export interface IdempotencyResult<T> {
  replayed: boolean;
  result: T;
}

interface StoredIdempotencyRecord {
  request_hash: string;
  response: TJsonValue;
}

type TJsonValue =
  | string
  | number
  | boolean
  | null
  | TJsonValue[]
  | { [key: string]: TJsonValue };

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super(
      "Idempotency key was already used with a different request"
    );

    this.name = "IdempotencyKeyConflictError";
  }
}

const validateInput = (
  input: IdempotencyInput
): void => {
  if (input.idempotencyKey.trim().length === 0) {
    throw new Error(
      "idempotencyKey must not be empty"
    );
  }

  if (input.requestHash.trim().length === 0) {
    throw new Error(
      "requestHash must not be empty"
    );
  }
};

export const executeIdempotently = async <T extends TJsonValue>(
  input: IdempotencyInput,
  operation: (client: PoolClient) => Promise<T>
): Promise<IdempotencyResult<T>> => {
  validateInput(input);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const insertResult = await client.query(
      `
        INSERT INTO idempotency_records (
          idempotency_key,
          request_hash,
          response
        )
        VALUES ($1, $2, 'null'::jsonb)
        ON CONFLICT (idempotency_key)
        DO NOTHING
        RETURNING idempotency_key
      `,
      [
        input.idempotencyKey,
        input.requestHash
      ]
    );

    if (insertResult.rowCount === 0) {
      const existingResult =
        await client.query<StoredIdempotencyRecord>(
          `
            SELECT
              request_hash,
              response
            FROM idempotency_records
            WHERE idempotency_key = $1
          `,
          [input.idempotencyKey]
        );

      if (existingResult.rowCount !== 1) {
        throw new Error(
          "Idempotency record was not found after conflict"
        );
      }

      const existing = existingResult.rows[0];

      if (existing.request_hash !== input.requestHash) {
        throw new IdempotencyKeyConflictError();
      }

      if (existing.response === null) {
        throw new Error(
          "Stored idempotency response is unexpectedly null"
        );
      }

      await client.query("COMMIT");

      return {
        replayed: true,
        result: existing.response as T
      };
    }

    const result = await operation(client);

    await client.query(
      `
        UPDATE idempotency_records
        SET response = $2::jsonb
        WHERE idempotency_key = $1
      `,
      [
        input.idempotencyKey,
        JSON.stringify(result)
      ]
    );

    await client.query("COMMIT");

    return {
      replayed: false,
      result
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original operation error.
    }

    throw error;
  } finally {
    client.release();
  }
};
```

### Step 2 — Understand the transaction

The service performs these steps on one PostgreSQL client:

```text
BEGIN
  |
  v
Attempt to insert idempotency key
  |
  +---- New key ----> Execute database operation
  |                         |
  |                         v
  |                  Store response
  |                         |
  |                         v
  |                       COMMIT
  |
  +---- Existing key --> Compare request hash
                            |
                            +--> Different hash: reject
                            |
                            +--> Same hash: return stored result
```

The business operation receives the same `PoolClient` used by the idempotency service. Its database queries must use that client to participate in the same transaction.

**Do not call `pool.query()` inside the operation callback for the protected business changes.** That would execute outside the transaction and break the atomicity this design relies on.

### Step 3 — Why store the response in the transaction?

Consider a crash after the business change but before the idempotency result is saved.

If the business change and the idempotency record are part of one transaction, PostgreSQL commits both or rolls back both.

That prevents the database from committing the business change while losing its idempotency record.

### Step 4 — Why use JSON-compatible results?

The response is stored in a PostgreSQL `JSONB` column.

This is appropriate for ordinary JSON results, but not every JavaScript value can be represented without loss. Do not return values such as `BigInt`, functions, or objects that rely on custom prototypes.

The service deliberately limits results to JSON-compatible values.

### Step 5 — Why is a placeholder response inserted?

The schema requires `response` to be non-null, so the insert initially uses JSON `null`.

The row remains uncommitted while the business operation executes. Another transaction attempting the same key must resolve the unique-key conflict before it can proceed.

If the first transaction commits, the second transaction can retrieve the stored response. If the first transaction rolls back, the second attempt can insert the key and perform the operation.

The service explicitly checks the request hash before returning a replayed result.

## 7. How Concurrent Requests Are Handled

Suppose two workers concurrently execute the same logical operation with key `order:create:abc`.

```text
Worker A                         Worker B
--------                         --------
BEGIN                            BEGIN
INSERT key succeeds              INSERT same key conflicts
Run business operation           Waits for conflict resolution
Save response
COMMIT
                                 Reads stored response
                                 COMMIT
```

The primary key on `idempotency_key` is the concurrency control mechanism. An application-level check such as `SELECT` followed by `INSERT` without a unique constraint is not sufficient.

### What if Worker A fails?

If Worker A's transaction rolls back, the inserted idempotency record and its database changes are rolled back together.

Worker B can then acquire the key and execute the operation.

### What if the same key has a different request hash?

The second request must fail with `IdempotencyKeyConflictError`. It must not reuse the first request's result.

### What if the operation sends an HTTP request?

This transaction cannot make a remote HTTP request atomic with PostgreSQL.

If the callback sends an HTTP request and then the PostgreSQL transaction fails, the remote side effect may already have happened.

For external side effects, use the provider's idempotency mechanism when available, or use a transactional outbox and a suitable delivery strategy. We will study the outbox pattern later in this module.

## 8. Write Integration Tests

These tests use real PostgreSQL. They are not ordinary mocked unit tests.

### Step 1 — Create the integration test file

**File: `tests/idempotency.service.integration.test.ts`**

Create this file with the complete code below.

```typescript
import {
  afterAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { pool } from "../src/database/pool.js";

import {
  executeIdempotently,
  IdempotencyKeyConflictError
} from "../src/services/idempotency.service.js";

const enabled =
  process.env.RUN_POSTGRES_INTEGRATION === "true";

describe.skipIf(!enabled)(
  "PostgreSQL idempotency integration tests",
  () => {
    afterAll(async () => {
      await pool.query(
        `
          DELETE FROM idempotency_records
          WHERE idempotency_key LIKE 'lecture-15:%'
        `
      );
    });

    it("executes the operation once and replays its result", async () => {
      const idempotencyKey =
        "lecture-15:replay-test";

      const operation = vi.fn(async () => ({
        orderId: "order-100",
        status: "created"
      }));

      const first = await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-order-100"
        },
        async () => operation()
      );

      const second = await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-order-100"
        },
        async () => operation()
      );

      expect(first).toEqual({
        replayed: false,
        result: {
          orderId: "order-100",
          status: "created"
        }
      });

      expect(second).toEqual({
        replayed: true,
        result: {
          orderId: "order-100",
          status: "created"
        }
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("rejects reuse of a key with a different request hash", async () => {
      const idempotencyKey =
        "lecture-15:hash-conflict";

      await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-request-A"
        },
        async () => ({
          result: "request-A"
        })
      );

      await expect(
        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-request-B"
          },
          async () => ({
            result: "request-B"
          })
        )
      ).rejects.toBeInstanceOf(
        IdempotencyKeyConflictError
      );
    });

    it("executes the operation once for concurrent duplicate requests", async () => {
      const idempotencyKey =
        "lecture-15:concurrent-test";

      let executions = 0;

      const operation = async () => {
        executions += 1;

        // Simulate asynchronous work inside the transaction.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });

        return {
          operationId: "operation-200",
          status: "completed"
        };
      };

      const [first, second] = await Promise.all([
        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-concurrent"
          },
          operation
        ),

        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-concurrent"
          },
          operation
        )
      ]);

      expect(executions).toBe(1);

      expect(
        [first.replayed, second.replayed].sort()
      ).toEqual([false, true]);

      expect(first.result).toEqual(second.result);
    });

    it("allows a retry after the first transaction rolls back", async () => {
      const idempotencyKey =
        "lecture-15:rollback-test";

      const firstOperation = vi.fn(async () => {
        throw new Error("Simulated operation failure");
      });

      await expect(
        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-rollback"
          },
          firstOperation
        )
      ).rejects.toThrow(
        "Simulated operation failure"
      );

      const retry = await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-rollback"
        },
        async () => ({
          result: "successful-retry"
        })
      );

      expect(retry).toEqual({
        replayed: false,
        result: {
          result: "successful-retry"
        }
      });

      expect(firstOperation).toHaveBeenCalledTimes(1);
    });
  }
);
```

### Step 2 — Understand the integration tests

The four tests cover:

1. **Replay:** A retry returns the original result without re-executing the operation.
2. **Hash conflict:** The same key cannot represent two different requests.
3. **Concurrent duplicate requests:** Only one transaction runs the operation callback.
4. **Rollback and retry:** If the first operation fails, the transaction rolls back and a later attempt can succeed.

The tests use unique keys with the `lecture-15:` prefix. Cleanup deletes only records belonging to this exercise.

## 9. Run and Verify the Tests

### Step 1 — Apply your migration

Use the existing migration runner from your project. Do not create a new migration runner for this lecture.

Confirm the `idempotency_records` table exists before running the integration tests.

### Step 2 — Run the focused tests

From the project root, in PowerShell:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "true"
npm run test:run -- tests/idempotency.service.integration.test.ts
```

Expected result: four integration tests pass.

If your test script has a different name, use the script already defined in your `package.json`.

### Step 3 — Reset the environment variable

```powershell
Remove-Item Env:RUN_POSTGRES_INTEGRATION -ErrorAction SilentlyContinue
```

### Step 4 — Run the complete test suite

```powershell
npm run test:run
```

The integration tests will be skipped unless the environment variable is enabled.

A skipped integration test is not evidence that the database behavior passed. Check the focused integration-test output separately.

## 10. Intentionally Break the Implementation

We will demonstrate what happens when the business operation is accidentally executed outside the idempotency transaction.

### Step 1 — Add an isolated test table

For this experiment, create a temporary table in a development database only.

**File: `src/database/migrations/NNN_lecture15_idempotency_demo.sql`**

Use the next unused migration number only if your project requires all schema changes to be tracked through migrations. Do not create a second migration just to repeat a table that already exists.

```sql
CREATE TABLE IF NOT EXISTS lecture15_idempotency_demo (
    operation_id TEXT PRIMARY KEY,
    execution_count INTEGER NOT NULL
);
```

Apply it through your existing migration runner.

### Step 2 — Write the business operation using the supplied client

In a temporary integration test or a small local test script, execute the following SQL through the `PoolClient` supplied to the idempotency callback:

```sql
INSERT INTO lecture15_idempotency_demo (
    operation_id,
    execution_count
)
VALUES ($1, 1)
ON CONFLICT (operation_id)
DO UPDATE SET
    execution_count =
      lecture15_idempotency_demo.execution_count + 1;
```

For the exercise, the operation should use a stable `operation_id` and run through `executeIdempotently()`.

The expected execution count after a successful request followed by a retry is `1`.

### Step 3 — Understand the intentional bug

If you move the business update to a separate `pool.query()` call, it no longer participates in the transaction managed by `executeIdempotently()`.

That can produce this failure:

1. The business update commits independently.
2. The idempotency transaction fails.
3. The idempotency record rolls back.
4. A retry runs the business update again.

The result can be duplicated even though the idempotency service uses a transaction.

### Step 4 — Restore the correct implementation

Keep the business database changes inside the callback's supplied `PoolClient`.

The business update and idempotency record must be part of the same transaction.

Do not leave the deliberately broken version in place.

## 11. Build and Verification

### Step 1 — Run the focused tests

```powershell
$env:RUN_POSTGRES_INTEGRATION = "true"
npm run test:run -- tests/idempotency.service.integration.test.ts
```

### Step 2 — Run the full test suite

```powershell
npm run test:run
```

### Step 3 — Run the TypeScript build

```powershell
npm run build
```

If the build fails, inspect the actual compiler error and match the imports and types to your current project.

Do not change `src/workers.ts`, the database pool, or existing migrations to work around an unrelated error.

Do not mark a test or build as successful until you have run it and seen the result.

## 12. Production Limitations

### 12.1 The request hash must be trustworthy

The service accepts a `requestHash`; it does not calculate one.

In a real API or worker, derive the hash from a canonical representation of the request's meaningful fields. Ensure that different requests cannot accidentally produce the same canonical input.

Do not blindly hash arbitrary JSON without considering key ordering, omitted fields, normalization, and which fields define the logical operation.

### 12.2 Idempotency records need a retention policy

An unbounded table will grow indefinitely.

A production system needs a policy for retaining and eventually deleting old records. The retention period must be long enough to cover realistic retries and delayed redelivery. Deleting a key too early can permit a previously completed operation to run again.

### 12.3 The stored result must be replayable

A stored response should contain enough information for the caller to recognize the original successful outcome.

Avoid storing secrets or unnecessary sensitive data. If the full response is too large or includes sensitive information, store a stable operation or resource identifier instead.

### 12.4 Database idempotency does not cover remote effects

The transaction only protects work that participates in the same PostgreSQL transaction.

If the callback sends an email, calls a payment provider, or invokes another service, PostgreSQL cannot roll back that external action.

For remote effects, use an appropriate external idempotency key or a transactional outbox design.

### 12.5 This service is not integrated into BullMQ

The new service is independent. We are not importing it into your worker or changing job handlers yet.

Before integration, the actual job payload, retry policy, transaction boundaries, and existing idempotency-related services must be reviewed to avoid duplicating functionality.

## 13. Final Folder Structure

The relevant structure should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/
│   │   │   └── NNN_idempotency_records.sql
│   │   └── pool.ts
│   ├── services/
│   │   └── idempotency.service.ts
│   └── workers.ts
└── tests/
    └── idempotency.service.integration.test.ts
```

`NNN_idempotency_records.sql` represents the actual next unused migration filename. Use your repository's existing numbering convention.

The `lecture15_idempotency_demo` table from the optional intentional-break exercise is not required for the main implementation. Do not add its migration unless you actually perform that experiment and want to keep it.

## 14. Success Criteria

- [ ] Inspected `src/database/migrations/` before creating the migration.
- [ ] Confirmed there is no existing equivalent idempotency table.
- [ ] Created the idempotency migration using the next valid sequence number.
- [ ] Created `src/services/idempotency.service.ts`.
- [ ] Created `tests/idempotency.service.integration.test.ts`.
- [ ] Verified successful replay does not execute the operation twice.
- [ ] Verified reuse of a key with a different request hash is rejected.
- [ ] Verified concurrent duplicate requests execute the operation once.
- [ ] Verified rollback permits a later retry.
- [ ] Ran the focused integration tests, full test suite, and TypeScript build.
- [ ] Kept `src/workers.ts` unchanged.
- [ ] Understand that the transaction protects database changes, not arbitrary external side effects.

## 15. Next Lecture

**Module 3 — Lecture 16: Transactional Outbox Pattern**

Next, we will address the gap that database idempotency alone cannot solve: committing a database change while reliably arranging delivery of an event or background task. We will study how an outbox record is committed alongside the business change and later delivered by a separate publisher.
