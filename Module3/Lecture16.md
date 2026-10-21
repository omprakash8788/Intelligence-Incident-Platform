
# Module 3 — Distributed Systems
# Lecture 16: Transactional Outbox Pattern

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [The Dual-Write Problem](#2-the-dual-write-problem)
3. [How the Transactional Outbox Works](#3-how-the-transactional-outbox-works)
4. [Project Scope and Folder Structure](#4-project-scope-and-folder-structure)
5. [Inspect Existing Migrations](#5-inspect-existing-migrations)
6. [Create the Outbox Migration](#6-create-the-outbox-migration)
7. [Implement the Transactional Outbox Service](#7-implement-the-transactional-outbox-service)
8. [Implement the Outbox Publisher](#8-implement-the-outbox-publisher)
9. [Write Integration Tests](#9-write-integration-tests)
10. [Run and Verify the Tests](#10-run-and-verify-the-tests)
11. [Intentionally Break the Design](#11-intentionally-break-the-design)
12. [Build and Verification](#12-build-and-verification)
13. [Production Considerations](#13-production-considerations)
14. [Final Folder Structure](#14-final-folder-structure)
15. [Success Criteria](#15-success-criteria)
16. [Next Lecture](#16-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why updating PostgreSQL and publishing a queue job are two separate operations.
- How the transactional outbox pattern prevents the database-change/event-publication dual-write problem.
- How to write the business change and outbox record in the same PostgreSQL transaction.
- How to claim pending outbox records without allowing multiple publishers to claim the same record simultaneously.
- Why a publisher can deliver the same event more than once.
- Why an outbox publisher needs retries, idempotency, and observability.

**Scope:** We will build an isolated PostgreSQL outbox service and publisher. We will not modify `src/workers.ts`, register a BullMQ worker, or wire the publisher into application startup.

## 2. The Dual-Write Problem

Imagine a background service creates an order in PostgreSQL and then adds a job to BullMQ to send an order-confirmation email.

The application performs two writes:

1. Commit the order to PostgreSQL.
2. Publish the corresponding job to BullMQ.

These operations do not share one atomic transaction.

### Failure A — Database succeeds, queue publishing fails

```text
PostgreSQL: Create order
        |
        v
COMMIT succeeds
        |
        v
Application crashes
        |
        v
BullMQ job is never published
```

The order exists, but the expected background work never starts.

### Failure B — Queue publishing succeeds, database transaction fails

```text
BullMQ: Publish job
        |
        v
Job becomes available
        |
        v
PostgreSQL transaction fails
        |
        v
Job refers to a business change that never committed
```

The queue contains a job for a business operation that did not successfully commit.

### Why not just use `try/catch`?

A `try/catch` can handle errors that the process observes. It cannot guarantee recovery if the process crashes between two independent systems.

We need a design where the business change and the intention to publish an event are committed together.

## 3. How the Transactional Outbox Works

The transactional outbox stores an event in PostgreSQL in the same transaction as the business change.

```text
                    PostgreSQL transaction
                  ┌────────────────────────┐
                  │ 1. Update business data│
                  │ 2. Insert outbox event │
                  └────────────┬───────────┘
                               |
                            COMMIT
                               |
                               v
                    Outbox publisher
                               |
                               v
                     BullMQ / external
                         destination
```

If the transaction rolls back, neither the business change nor its outbox event is committed.

If the transaction commits, the outbox event is durable and can be published later, even if the application crashes immediately after the commit.

### Delivery guarantee

The usual outbox publisher provides **at-least-once delivery**, not exactly-once delivery.

Consider this sequence:

1. Publisher sends an event.
2. The destination accepts the event.
3. Publisher crashes before marking the outbox row as published.
4. Another publisher retries the event.

The event may be delivered twice.

Therefore, consumers must be idempotent, or the destination must support a suitable idempotency mechanism.

## 4. Project Scope and Folder Structure

We will add these files:

```text
src/
├── database/
│   └── migrations/
│       └── NNN_transactional_outbox.sql
└── services/
    ├── outbox-transaction.service.ts
    └── outbox-publisher.service.ts

tests/
└── outbox.integration.test.ts
```

`NNN_transactional_outbox.sql` is a placeholder for the next valid migration number in your existing sequence.

We will not create a new root-level `database/` directory.

We will not modify:

- `src/workers.ts`
- `src/server.ts`
- Existing Redis or PostgreSQL configuration
- Existing leader-election services
- Existing migration files

## 5. Inspect Existing Migrations

Before creating the migration, inspect your existing migration directory.

**Directory: `src/database/migrations/`**

In PowerShell:

```powershell
Get-ChildItem .\src\database\migrations\ |
  Sort-Object Name |
  Select-Object Name
```

Search for existing outbox-related schema definitions:

```powershell
Get-ChildItem .\src\database\migrations\ -File |
  Select-String -Pattern 'outbox|published_at|locked_until'
```

Also check the current source tree for an existing outbox service or table.

If your project already has an equivalent outbox table, **do not create another table**. Adapt the services in this lecture to the existing schema.

If there is no equivalent table, continue to the migration step.

## 6. Create the Outbox Migration

### Step 1 — Create the next migration file

**File: `src/database/migrations/NNN_transactional_outbox.sql`**

Replace `NNN` with the next unused migration number in your repository.

Create this file with the complete SQL below:

```sql
CREATE TABLE transactional_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    event_id UUID NOT NULL UNIQUE,

    event_type TEXT NOT NULL,

    payload JSONB NOT NULL,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT clock_timestamp(),

    published_at TIMESTAMPTZ NULL,

    locked_until TIMESTAMPTZ NULL,

    locked_by TEXT NULL,

    attempts INTEGER NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    last_error TEXT NULL
);

CREATE INDEX transactional_outbox_pending_idx
ON transactional_outbox (id)
WHERE published_at IS NULL;
```

### Step 2 — Understand the schema

| Column | Purpose |
|---|---|
| `id` | Database-generated row identifier |
| `event_id` | Stable identifier for the logical event |
| `event_type` | Identifies the event's meaning |
| `payload` | JSON data delivered to the destination |
| `created_at` | Time the event was created |
| `published_at` | Time successful publication was recorded |
| `locked_until` | Expiration time of a publisher's claim |
| `locked_by` | Identifies the publisher that currently owns the claim |
| `attempts` | Number of publication attempts |
| `last_error` | Most recent publication error |

The unique constraint on `event_id` prevents the same event identifier from being inserted twice.

The partial index helps PostgreSQL find rows that have not yet been marked as published.

### Step 3 — Apply the migration

Use your existing project migration runner. Do not create a new migration runner for this lecture.

After the migration runs, verify that `transactional_outbox` exists in the intended database.

Do not manually execute this migration if your project requires all schema changes to be applied through its migration runner.

## 7. Implement the Transactional Outbox Service

This service writes an outbox event using the same PostgreSQL transaction as the business operation.

### Step 1 — Create the service file

**File: `src/services/outbox-transaction.service.ts`**

Create this file with the complete code below.

```typescript
import type {
  PoolClient
} from "pg";

import { randomUUID } from "node:crypto";

import { pool } from "../database/pool.js";

export interface OutboxEventInput {
  eventId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxTransactionResult<T> {
  result: T;
  eventId: string;
}

export const executeWithOutbox = async <T>(
  operation: (
    client: PoolClient
  ) => Promise<T>,
  event: OutboxEventInput
): Promise<OutboxTransactionResult<T>> => {
  if (event.eventType.trim().length === 0) {
    throw new Error(
      "eventType must not be empty"
    );
  }

  const eventId = event.eventId ?? randomUUID();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await operation(client);

    await client.query(
      `
        INSERT INTO transactional_outbox (
          event_id,
          event_type,
          payload
        )
        VALUES ($1, $2, $3::jsonb)
      `,
      [
        eventId,
        event.eventType,
        JSON.stringify(event.payload)
      ]
    );

    await client.query("COMMIT");

    return {
      result,
      eventId
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }

    throw error;
  } finally {
    client.release();
  }
};
```

### Step 2 — Understand the transaction boundary

The critical part is:

```typescript
await client.query("BEGIN");

const result = await operation(client);

await client.query(
  `
    INSERT INTO transactional_outbox (
      event_id,
      event_type,
      payload
    )
    VALUES ($1, $2, $3::jsonb)
  `,
  [
    eventId,
    event.eventType,
    JSON.stringify(event.payload)
  ]
);

await client.query("COMMIT");
```

The business operation and outbox insertion use the same client and transaction.

If either operation fails before commit, the transaction is rolled back.

**Important:** The callback must use the supplied `PoolClient` for its database changes. Calling `pool.query()` independently inside the callback would run that query outside this transaction.

### Step 3 — Why does the caller provide an event ID optionally?

A caller may provide a stable event ID if it already has one.

Otherwise, the service generates a UUID.

For retries of the same logical operation, a stable event ID is preferable. Generating a new event ID on every retry can create duplicate logical events if the original transaction committed but the caller did not receive the response.

A production caller should derive or persist a stable event identifier where retry semantics require it.

## 8. Implement the Outbox Publisher

The publisher claims pending rows, sends events to a destination, and marks successfully published rows.

For this lecture, the destination is an injected function. We are not connecting to BullMQ yet.

### Step 1 — Create the publisher file

**File: `src/services/outbox-publisher.service.ts`**

Create this file with the complete code below.

```typescript
import { pool } from "../database/pool.js";

export interface OutboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface ClaimedOutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxPublisherConfig {
  publisherId: string;
  batchSize: number;
  claimDurationMs: number;
}

export type PublishOutboxEvent = (
  event: OutboxEvent
) => Promise<void>;

export class OutboxPublisher {
  constructor(
    private readonly config: OutboxPublisherConfig,
    private readonly publish: PublishOutboxEvent
  ) {
    if (
      config.publisherId.trim().length === 0
    ) {
      throw new Error(
        "publisherId must not be empty"
      );
    }

    if (
      !Number.isSafeInteger(config.batchSize) ||
      config.batchSize < 1
    ) {
      throw new Error(
        "batchSize must be a positive safe integer"
      );
    }

    if (
      !Number.isSafeInteger(config.claimDurationMs) ||
      config.claimDurationMs < 1
    ) {
      throw new Error(
        "claimDurationMs must be a positive safe integer"
      );
    }
  }

  async publishBatch(): Promise<{
    claimed: number;
    published: number;
    failed: number;
  }> {
    const client = await pool.connect();

    let rows: ClaimedOutboxRow[];

    try {
      await client.query("BEGIN");

      const claimResult =
        await client.query<ClaimedOutboxRow>(
          `
            WITH candidates AS (
              SELECT id
              FROM transactional_outbox
              WHERE published_at IS NULL
                AND (
                  locked_until IS NULL
                  OR locked_until < clock_timestamp()
                )
              ORDER BY id
              FOR UPDATE SKIP LOCKED
              LIMIT $1
            )
            UPDATE transactional_outbox AS outbox
            SET
              locked_by = $2,
              locked_until =
                clock_timestamp()
                + ($3::bigint * interval '1 millisecond'),
              attempts = outbox.attempts + 1
            FROM candidates
            WHERE outbox.id = candidates.id
            RETURNING
              outbox.id,
              outbox.event_id,
              outbox.event_type,
              outbox.payload,
              outbox.attempts
          `,
          [
            this.config.batchSize,
            this.config.publisherId,
            this.config.claimDurationMs
          ]
        );

      rows = claimResult.rows;

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }

      throw error;
    } finally {
      client.release();
    }

    let published = 0;
    let failed = 0;

    for (const row of rows) {
      const event: OutboxEvent = {
        id: row.id,
        eventId: row.event_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts
      };

      try {
        await this.publish(event);

        const markResult = await pool.query(
          `
            UPDATE transactional_outbox
            SET
              published_at = clock_timestamp(),
              locked_by = NULL,
              locked_until = NULL,
              last_error = NULL
            WHERE id = $1
              AND locked_by = $2
              AND published_at IS NULL
          `,
          [
            row.id,
            this.config.publisherId
          ]
        );

        if (markResult.rowCount === 1) {
          published += 1;
        } else {
          // Publication may already have happened,
          // but this publisher no longer owns the claim.
          failed += 1;
        }
      } catch (error) {
        failed += 1;

        const message =
          error instanceof Error
            ? error.message
            : "Unknown publication error";

        await pool.query(
          `
            UPDATE transactional_outbox
            SET
              locked_by = NULL,
              locked_until = NULL,
              last_error = $3
            WHERE id = $1
              AND locked_by = $2
              AND published_at IS NULL
          `,
          [
            row.id,
            this.config.publisherId,
            message.slice(0, 2000)
          ]
        );
      }
    }

    return {
      claimed: rows.length,
      published,
      failed
    };
  }
}
```

### Step 2 — Understand claiming

The claim operation uses:

```sql
FOR UPDATE SKIP LOCKED
```

This lets concurrent publishers select different eligible rows rather than blocking on the same locked candidates.

The selected rows are assigned to a publisher and given a claim expiration.

The claim transaction commits before the publisher sends events. This avoids holding database row locks during a network request.

### Step 3 — Understand the claim lease

A claim has a limited lifetime.

If a publisher crashes after claiming rows, another publisher can eventually reclaim them after `locked_until` expires.

This avoids leaving events permanently stuck because a publisher died.

However, if publishing takes longer than the claim duration, another publisher may reclaim the same event while the first publisher is still sending it.

A production system needs an appropriate claim duration or a claim-renewal mechanism, and consumers must tolerate duplicate delivery.

### Step 4 — Understand the publication boundary

The publisher performs two separate actions:

1. Send the event to the destination.
2. Mark the outbox row as published.

A crash between these actions can cause the event to be sent again.

This is expected behavior for an at-least-once publisher.

The `eventId` must remain stable across attempts so consumers can deduplicate where appropriate.

### Step 5 — Why use `locked_by` when marking a row?

The update includes:

```sql
WHERE id = $1
  AND locked_by = $2
  AND published_at IS NULL
```

This prevents a publisher that no longer owns the claim from marking the row as published.

It does not undo an external publication that already occurred. It only protects the outbox row's state.

### Step 6 — Understand the publisher's limitations

This publisher is a learning implementation, not a complete production scheduler.

For example, a failure while recording `last_error` can cause `publishBatch()` itself to reject. An expired claim can permit a second publisher to send an event while the first send is still in progress.

We will test the basic transactional and publication behaviors first, then address retry policy, idempotent consumers, and failure recovery in later lectures.

## 9. Write Integration Tests

These tests require a running PostgreSQL instance and the applied outbox migration.

### Step 1 — Create the test file

**File: `tests/outbox.integration.test.ts`**

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
  executeWithOutbox
} from "../src/services/outbox-transaction.service.js";

import {
  OutboxPublisher
} from "../src/services/outbox-publisher.service.js";

const enabled =
  process.env.RUN_POSTGRES_INTEGRATION === "true";

describe.skipIf(!enabled)(
  "Transactional outbox integration tests",
  () => {
    afterAll(async () => {
      await pool.query(
        `
          DELETE FROM transactional_outbox
          WHERE event_type LIKE 'lecture-16.%'
        `
      );
    });

    it(
      "commits the outbox event with the business transaction",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000001";

        const result = await executeWithOutbox(
          async (client) => {
            await client.query(
              `
                SELECT 1
              `
            );

            return {
              orderId: "lecture-16-order-1"
            };
          },
          {
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-1"
            }
          }
        );

        expect(result.result).toEqual({
          orderId: "lecture-16-order-1"
        });

        expect(result.eventId).toBe(eventId);

        const stored = await pool.query(
          `
            SELECT event_id, event_type, payload
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(1);

        expect(stored.rows[0]).toEqual({
          event_id: eventId,
          event_type: "lecture-16.order-created",
          payload: {
            orderId: "lecture-16-order-1"
          }
        });
      }
    );

    it(
      "rolls back the outbox event when the business operation fails",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000002";

        await expect(
          executeWithOutbox(
            async () => {
              throw new Error(
                "Simulated business failure"
              );
            },
            {
              eventId,
              eventType: "lecture-16.order-created",
              payload: {
                orderId: "lecture-16-order-2"
              }
            }
          )
        ).rejects.toThrow(
          "Simulated business failure"
        );

        const stored = await pool.query(
          `
            SELECT event_id
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(0);
      }
    );

    it(
      "publishes an eligible event and marks it published",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000003";

        await pool.query(
          `
            DELETE FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        await executeWithOutbox(
          async () => ({
            orderId: "lecture-16-order-3"
          }),
          {
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-3"
            }
          }
        );

        const publish = vi.fn(
          async () => undefined
        );

        const publisher = new OutboxPublisher(
          {
            publisherId: "lecture-16-publisher-A",
            batchSize: 10,
            claimDurationMs: 30_000
          },
          publish
        );

        const result = await publisher.publishBatch();

        expect(result.claimed).toBeGreaterThanOrEqual(1);
        expect(result.published).toBeGreaterThanOrEqual(1);

        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-3"
            }
          })
        );

        const stored = await pool.query(
          `
            SELECT published_at
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(1);
        expect(stored.rows[0].published_at).not.toBeNull();
      }
    );

    it(
      "releases the claim for a failed publication",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000004";

        await pool.query(
          `
            DELETE FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        await executeWithOutbox(
          async () => ({
            orderId: "lecture-16-order-4"
          }),
          {
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-4"
            }
          }
        );

        const publisher = new OutboxPublisher(
          {
            publisherId: "lecture-16-publisher-B",
            batchSize: 10,
            claimDurationMs: 30_000
          },
          async (event) => {
            if (event.eventId === eventId) {
              throw new Error(
                "Simulated destination failure"
              );
            }
          }
        );

        const result = await publisher.publishBatch();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const stored = await pool.query(
          `
            SELECT
              published_at,
              locked_by,
              locked_until,
              attempts,
              last_error
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(1);

        expect(stored.rows[0].published_at).toBeNull();
        expect(stored.rows[0].locked_by).toBeNull();
        expect(stored.rows[0].locked_until).toBeNull();
        expect(stored.rows[0].attempts).toBeGreaterThanOrEqual(1);
        expect(stored.rows[0].last_error).toBe(
          "Simulated destination failure"
        );
      }
    );
  }
);
```

### Step 2 — Understand the tests

The tests verify four behaviors:

1. The outbox event is visible after the transaction commits.
2. A business-operation failure rolls back the outbox event.
3. A publisher can deliver an event and mark it published.
4. A failed publication leaves the event eligible for a later retry.

The tests use fixed event IDs so the relevant rows can be inspected and cleaned up reliably.

The publisher claims any eligible pending rows, so the assertions allow for other eligible events in the development database. For a dedicated test database, keeping the outbox clear of unrelated test events makes results easier to interpret.

## 10. Run and Verify the Tests

### Step 1 — Confirm PostgreSQL is running

From your project root:

```powershell
docker compose ps
```

Confirm the PostgreSQL service is running.

### Step 2 — Apply the migration

Use your existing migration runner and verify that `transactional_outbox` exists.

Do not create a duplicate table if one already exists.

### Step 3 — Run the focused integration tests

In PowerShell:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "true"
npm run test:run -- tests/outbox.integration.test.ts
```

Expected result: all four integration tests pass.

If your test script has another name, use the existing script from `package.json`.

### Step 4 — Reset the environment variable

```powershell
Remove-Item Env:RUN_POSTGRES_INTEGRATION -ErrorAction SilentlyContinue
```

### Step 5 — Run the full test suite

```powershell
npm run test:run
```

The integration tests will be skipped unless the environment variable is enabled.

A skipped integration test does not verify PostgreSQL behavior. Record the focused integration-test result separately.

## 11. Intentionally Break the Design

We will demonstrate why the outbox event must be in the same transaction as the business change.

### Step 1 — Understand the correct sequence

The correct design is:

```text
BEGIN
  Business database operation
  Insert outbox event
COMMIT
```

Both database changes succeed together or roll back together.

### Step 2 — Introduce the conceptual bug

Temporarily change the implementation in `src/services/outbox-transaction.service.ts` so the outbox insert occurs after the transaction commits.

The broken sequence becomes:

```text
BEGIN
  Business database operation
COMMIT

Insert outbox event separately
```

If the process crashes between `COMMIT` and the outbox insert, the business change exists without a corresponding outbox event.

### Step 3 — Verify the failure scenario

Use a development-only test or controlled experiment:

1. Perform a business database change.
2. Commit it.
3. Simulate a failure before inserting the outbox event.
4. Inspect the database.

You will observe that the business change can exist without its event.

Do not use production data for this experiment.

### Step 4 — Restore the correct implementation

Restore the original transaction structure in `src/services/outbox-transaction.service.ts`:

- Begin the transaction.
- Execute the business operation using the supplied client.
- Insert the outbox event using the same client.
- Commit only after both operations succeed.
- Roll back if either operation fails.

Run the focused tests again.

**Never leave the deliberately broken version in place.**

## 12. Build and Verification

### Step 1 — Run the focused integration tests

```powershell
$env:RUN_POSTGRES_INTEGRATION = "true"
npm run test:run -- tests/outbox.integration.test.ts
```

### Step 2 — Run the complete test suite

```powershell
npm run test:run
```

### Step 3 — Run the TypeScript build

```powershell
npm run build
```

If the build fails, investigate the actual TypeScript error and compare your implementation with the existing project conventions.

Do not modify `src/workers.ts`, the PostgreSQL pool, or existing migrations to work around an unrelated error.

Do not claim a test or build passed unless you have run it and seen the result.

## 13. Production Considerations

### 13.1 The publisher is at-least-once

A crash can occur after the destination accepts an event but before PostgreSQL records `published_at`.

The publisher will eventually retry the event, which can produce a duplicate delivery.

Use a stable `eventId` and make the consumer idempotent where duplicate processing would cause an unwanted effect.

### 13.2 Do not hold database locks while publishing

The publisher claims rows and commits the claim transaction before sending events.

This avoids holding row locks during network calls.

However, claim expiry can allow duplicate publication if a send takes longer than the claim duration. Production systems may need claim renewal, timeouts, and monitoring.

### 13.3 Retry policy and dead-letter handling are not complete here

This implementation releases failed claims immediately. A later publisher can retry them immediately, potentially creating a tight retry loop when the destination is unavailable.

A production implementation should add:

- Exponential backoff and jitter.
- A maximum retry policy or operational dead-letter state.
- Metrics for pending, claimed, published, and failed events.
- Alerts for events that remain unpublished too long.
- A recovery process for abandoned claims.

These behaviors should be implemented and tested before relying on the publisher in production.

### 13.4 Consumer idempotency is essential

The outbox guarantees durable intent to publish, not exactly-once processing by the consumer.

A consumer may record processed event IDs or use a business-level unique constraint to avoid repeating effects.

### 13.5 This lecture does not integrate BullMQ

The `publish` callback is an injected destination function. The integration tests use a mock function to focus on PostgreSQL and outbox behavior.

No BullMQ queue is created, and no worker or server file is changed.

Before connecting BullMQ, review the actual queue names, job payload types, retry policy, and idempotency rules in your project.

## 14. Final Folder Structure

The relevant structure after this lecture should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/
│   │   │   └── NNN_transactional_outbox.sql
│   │   └── pool.ts
│   ├── services/
│   │   ├── outbox-transaction.service.ts
│   │   └── outbox-publisher.service.ts
│   └── workers.ts
└── tests/
    └── outbox.integration.test.ts
```

`NNN_transactional_outbox.sql` is the actual next migration filename in your repository, not a literal filename to create.

No changes to `src/workers.ts` are required.

## 15. Success Criteria

- [ ] Inspected `src/database/migrations/` for an existing outbox schema.
- [ ] Created a migration only if an equivalent table does not already exist.
- [ ] Applied the migration using the existing migration runner.
- [ ] Created `src/services/outbox-transaction.service.ts`.
- [ ] Created `src/services/outbox-publisher.service.ts`.
- [ ] Created `tests/outbox.integration.test.ts`.
- [ ] Verified the outbox event commits with the database transaction.
- [ ] Verified the event is rolled back when the business operation fails.
- [ ] Verified a publisher can mark an event as published.
- [ ] Verified a failed publication releases its claim for retry.
- [ ] Restored the correct transaction structure after the intentional break.
- [ ] Ran the focused integration tests, full test suite, and TypeScript build.
- [ ] Left `src/workers.ts` unchanged.
- [ ] Understand that outbox delivery is at-least-once and consumers need duplicate protection.

## 16. Next Lecture

**Module 3 — Lecture 17: Saga Pattern and Distributed Compensation**

Next, we will examine workflows that span multiple services or transactions. We will learn why a local database transaction cannot roll back a completed remote operation, how a saga coordinates steps and compensating actions, and how retries and partial failures affect the workflow.
