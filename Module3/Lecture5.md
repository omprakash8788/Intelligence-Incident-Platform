
# Module 3 — Lecture 5: Lock Expiration, Leases, and Fencing Tokens

## Table of Contents

1. Learning objectives
2. Understand the stale-worker problem
3. Why a Redis TTL is not enough
4. Understand fencing tokens
5. Create the PostgreSQL migration
6. Build the fencing-token service
7. Write unit tests
8. Run the migration and verify
9. Break it intentionally
10. Apply fencing to BullMQ workers
11. Production considerations
12. Final checklist

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a worker can continue running after its Redis lock expires.
- Why a lease does not forcibly stop its owner.
- How fencing tokens identify the order of lock owners.
- How PostgreSQL can generate monotonically increasing tokens for each resource.
- How to reject stale writes using a conditional database operation.
- Why token generation and token enforcement are both necessary.
- Why fencing tokens complement, rather than replace, idempotency.

We will use your existing stack:

- Node.js
- TypeScript
- PostgreSQL
- Redis/ioredis
- BullMQ
- Vitest

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Before starting, ensure Lecture 4's policy tests and your TypeScript build pass.

---

## 2. Understand the Stale-Worker Problem

Imagine that a worker acquires a Redis lock for a report.

```text
Time ───────────────────────────────────────────────>

Worker A:
Acquire lock ─────── Work ─────── Paused ─────── Resume
                  |
                  | Lock expires while paused
                  v

Worker B:
                         Acquire lock ─── Write new state
```

Worker A might pause because of:

- A long garbage-collection pause.
- A machine or container suspension.
- Network delays.
- A slow external dependency.
- Unexpectedly long-running processing.

When A's Redis lease expires, B may acquire the same lock.

But Redis cannot reach into Worker A and stop its JavaScript execution. When A resumes, it might still attempt to write data.

This is the **stale-worker problem**.

### The dangerous scenario

1. Worker A acquires a lock.
2. Worker A begins processing.
3. A's lock expires.
4. Worker B acquires the lock.
5. B writes the latest report.
6. A resumes and overwrites B's result.

Both workers may have executed valid lock-acquisition code. The problem is that A continued acting after its lease was no longer current.

---

## 3. Why a Redis TTL Is Not Enough

Your existing Redis command is:

```redis
SET lock:account:1001 test-token NX PX 60000
```

The TTL gives the lock a limited lifetime. It helps recover from crashed owners, but it does not terminate the owner when time expires.

There are three different concepts:

| Concept | What it does |
|---|---|
| Lock | Coordinates ownership |
| Lease | Limits how long ownership is granted |
| Fencing token | Lets a downstream resource reject older owners |

A lock and lease help coordinate workers. A fencing token helps protect the resource being modified.

The crucial requirement is that the **downstream resource must enforce the fencing token**. Merely generating or logging tokens does not prevent stale writes.

---

## 4. Understand Fencing Tokens

A fencing token is a monotonically increasing number assigned to each new owner of a resource.

For example:

| Owner | Fencing token |
|---|---:|
| Worker A | 41 |
| Worker B | 42 |
| Worker C | 43 |

The downstream database remembers the greatest accepted token for each resource.

If the database has already accepted token `42`, it rejects a write carrying token `41`.

```text
Worker A: token 41 ───────┐
                          |
Worker B: token 42 ───────┼──> PostgreSQL
                          |
                          v

Latest accepted token = 42

Token 42: accepted
Token 41: rejected as stale
```

### Important distinction

A fencing token must come from an authoritative, monotonically increasing source. A random UUID is useful as a lock ownership token, but it is not a fencing token because random UUIDs do not establish chronological order.

For this lecture, PostgreSQL will allocate fencing tokens. This gives us an atomic counter per resource.

We will not implement a complete Redlock client here. We will build the downstream protection mechanism that can be used with a lock implementation.

---

## 5. Create the PostgreSQL Migration

We need two tables:

1. `lock_fencing_state` — allocates monotonically increasing tokens.
2. `fenced_resource_state` — stores the most recent accepted token for each resource.

### 5.1 Create the migration

**File:** `src/database/migrations/20261017_create_fencing_state.sql`

**Action:** Create a new migration using the filename convention required by your existing migration runner. If that filename is already in use, choose a unique filename. Never overwrite an applied migration.

```sql
CREATE TABLE IF NOT EXISTS lock_fencing_state (
    resource_key TEXT PRIMARY KEY,

    last_token BIGINT NOT NULL
        CHECK (last_token > 0),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fenced_resource_state (
    resource_key TEXT PRIMARY KEY,

    last_fencing_token BIGINT NOT NULL DEFAULT 0
        CHECK (last_fencing_token >= 0),

    last_operation_id TEXT NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Why separate the tables?

`lock_fencing_state` issues tokens. It must not decrease a resource's token when the resource's stored business state changes.

`fenced_resource_state` records which token last successfully modified the protected state.

Keeping these responsibilities separate makes the ordering rule explicit.

### Why use PostgreSQL `BIGINT`?

The counter should not be limited to JavaScript's ordinary integer range.

PostgreSQL's `BIGINT` can hold values larger than JavaScript's safe integer range. We will represent tokens as strings in TypeScript so they are not accidentally rounded.

---

## 6. Build the Fencing-Token Service

### 6.1 Create the service

**File:** `src/services/fencing-token.service.ts`

**Action:** Create this file.

The implementation assumes your existing database pool is exported as `pool` from `src/database/pool.ts`. Reuse that pool rather than creating a new PostgreSQL connection pool.

```ts
import { pool } from "../database/pool.js";

export interface FencedWriteResult {
  accepted: boolean;
  resourceKey: string;
  fencingToken: string;
  operationId: string;
}

export class FencingTokenService {
  async allocateToken(
    resourceKey: string
  ): Promise<string> {
    if (!resourceKey.trim()) {
      throw new Error("Resource key is required");
    }

    const result = await pool.query<{ token: string }>(
      `
        INSERT INTO lock_fencing_state (
          resource_key,
          last_token
        )
        VALUES ($1, 1)

        ON CONFLICT (resource_key)
        DO UPDATE SET
          last_token = lock_fencing_state.last_token + 1,
          updated_at = NOW()

        RETURNING last_token::text AS token
      `,
      [resourceKey]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(
        "Failed to allocate fencing token"
      );
    }

    return row.token;
  }

  async applyFencedWrite(
    resourceKey: string,
    fencingToken: string,
    operationId: string
  ): Promise<FencedWriteResult> {
    if (!resourceKey.trim()) {
      throw new Error("Resource key is required");
    }

    if (!/^[1-9]\d*$/.test(fencingToken)) {
      throw new Error(
        "Fencing token must be a positive integer string"
      );
    }

    if (!operationId.trim()) {
      throw new Error("Operation ID is required");
    }

    const result = await pool.query<{
      resource_key: string;
      fencing_token: string;
      operation_id: string;
    }>(
      `
        INSERT INTO fenced_resource_state (
          resource_key,
          last_fencing_token,
          last_operation_id
        )
        VALUES ($1, $2::bigint, $3)

        ON CONFLICT (resource_key)
        DO UPDATE SET
          last_fencing_token = EXCLUDED.last_fencing_token,
          last_operation_id = EXCLUDED.last_operation_id,
          updated_at = NOW()

        WHERE
          fenced_resource_state.last_fencing_token
          < EXCLUDED.last_fencing_token

        RETURNING
          resource_key,
          last_fencing_token::text AS fencing_token,
          last_operation_id AS operation_id
      `,
      [resourceKey, fencingToken, operationId]
    );

    const row = result.rows[0];

    if (!row) {
      return {
        accepted: false,
        resourceKey,
        fencingToken,
        operationId
      };
    }

    return {
      accepted: true,
      resourceKey: row.resource_key,
      fencingToken: row.fencing_token,
      operationId: row.operation_id
    };
  }
}

export const fencingTokenService =
  new FencingTokenService();
```

### 6.2 Understand token allocation

The important SQL operation is:

```sql
INSERT INTO lock_fencing_state (
    resource_key,
    last_token
)
VALUES ($1, 1)

ON CONFLICT (resource_key)
DO UPDATE SET
    last_token = lock_fencing_state.last_token + 1

RETURNING last_token::text AS token;
```

For a new resource, the first token is `1`.

For an existing resource, PostgreSQL atomically increments the counter.

Concurrent token-allocation requests for the same row are serialized by PostgreSQL's conflict handling and row locking. They cannot both successfully allocate the same counter value.

### 6.3 Understand the stale-write protection

The key condition is:

```sql
WHERE
    fenced_resource_state.last_fencing_token
    < EXCLUDED.last_fencing_token
```

This allows a write only when its token is greater than the last accepted token.

If the condition is false, PostgreSQL updates no row, and the service returns `accepted: false`.

This operation is atomic. The comparison and update occur in the same SQL statement, so two competing writes cannot bypass the check by racing between a separate read and write.

### 6.4 Why does the service return `accepted: false`?

A rejected token is not necessarily a database failure. It may mean that an older worker attempted to write after a newer owner had already updated the resource.

The caller must treat `accepted: false` as a rejected stale write and must not claim that the operation succeeded.

---

## 7. Write Unit Tests

We will mock the PostgreSQL pool to test input validation and how the service interprets database results. These tests do not replace integration tests against a real PostgreSQL instance.

### 7.1 Create the test file

**File:** `tests/fencing-token.service.test.ts`

**Action:** Create this file.

```ts
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    query: vi.fn()
  }
}));

vi.mock("../src/database/pool.js", () => ({
  pool: poolMock
}));

import {
  FencingTokenService
} from "../src/services/fencing-token.service.js";

describe("FencingTokenService", () => {
  let service: FencingTokenService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FencingTokenService();
  });

  it("allocates and returns a fencing token", async () => {
    poolMock.query.mockResolvedValue({
      rows: [{ token: "41" }],
      rowCount: 1
    });

    await expect(
      service.allocateToken("report:1001")
    ).resolves.toBe("41");

    expect(poolMock.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "last_token = lock_fencing_state.last_token + 1"
      ),
      ["report:1001"]
    );
  });

  it("rejects an empty resource key", async () => {
    await expect(
      service.allocateToken(" ")
    ).rejects.toThrow("Resource key is required");

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("accepts a newer fencing token", async () => {
    poolMock.query.mockResolvedValue({
      rows: [
        {
          resource_key: "report:1001",
          fencing_token: "42",
          operation_id: "operation-B"
        }
      ],
      rowCount: 1
    });

    await expect(
      service.applyFencedWrite(
        "report:1001",
        "42",
        "operation-B"
      )
    ).resolves.toEqual({
      accepted: true,
      resourceKey: "report:1001",
      fencingToken: "42",
      operationId: "operation-B"
    });
  });

  it("rejects a stale fencing token", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    await expect(
      service.applyFencedWrite(
        "report:1001",
        "41",
        "operation-A"
      )
    ).resolves.toEqual({
      accepted: false,
      resourceKey: "report:1001",
      fencingToken: "41",
      operationId: "operation-A"
    });
  });

  it("rejects a non-numeric fencing token", async () => {
    await expect(
      service.applyFencedWrite(
        "report:1001",
        "token-42",
        "operation-A"
      )
    ).rejects.toThrow(
      "Fencing token must be a positive integer string"
    );

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("rejects an empty operation ID", async () => {
    await expect(
      service.applyFencedWrite(
        "report:1001",
        "42",
        " "
      )
    ).rejects.toThrow("Operation ID is required");

    expect(poolMock.query).not.toHaveBeenCalled();
  });
});
```

### 7.2 Run the tests

**PowerShell — project root:**

```powershell
npm run test:run -- tests/fencing-token.service.test.ts
```

Expected: all six tests pass.

Then build:

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

If your pool export has a different name, adapt the import to your existing implementation. Do not create another pool just for this service.

---

## 8. Run the Migration and Verify

### 8.1 Check your migration runner

Before applying the migration, inspect the existing migration files and `src/database/migrate.ts`.

Confirm that:

- The filename matches your project's migration naming convention.
- The migration runner recognizes `.sql` files.
- The migration has not already been applied.
- The tables do not conflict with an existing migration.

Then run the project's migration command:

```powershell
npm run migrate
```

If the migration runner uses a different convention or reports an error, stop and resolve it before proceeding.

### 8.2 Verify the tables

Use your existing PostgreSQL Compose service name and credentials.

If the service is named `postgres`, run:

```powershell
docker compose exec postgres psql -U postgres -d production_intelligence -c "\dt"
```

Confirm that both `lock_fencing_state` and `fenced_resource_state` appear.

If your service name, database name, or credentials differ, use the values from your actual Compose configuration.

### 8.3 Verify token allocation

Run this SQL against your development database:

```sql
SELECT resource_key, last_token
FROM lock_fencing_state
ORDER BY resource_key;
```

Initially, the table may be empty. It will contain rows after the service allocates tokens.

---

## 9. Break It Intentionally

Use a development database only.

### Experiment A: Allocate two tokens

Temporarily call the service twice for the same resource:

```ts
const first = await fencingTokenService.allocateToken(
  "report:1001"
);

const second = await fencingTokenService.allocateToken(
  "report:1001"
);

console.log({ first, second });
```

Expected: `second` is greater than `first`.

For example:

```text
{ first: "1", second: "2" }
```

If you run the experiment again, the values will continue increasing rather than resetting to `1`.

### Experiment B: Write with token 42, then token 41

Use a clean test resource. The following example assumes the allocator has already issued both tokens and the resource has not previously accepted a higher token.

```ts
const newer = await fencingTokenService.applyFencedWrite(
  "report:stale-worker-test",
  "42",
  "operation-B"
);

const older = await fencingTokenService.applyFencedWrite(
  "report:stale-worker-test",
  "41",
  "operation-A"
);

console.log({ newer, older });
```

Expected:

- `newer.accepted` is `true`.
- `older.accepted` is `false`.

The second write must not replace the accepted state.

**Root cause:** The SQL condition rejects tokens that are not greater than the last accepted token.

**Fix:** Keep the comparison and update in one atomic SQL statement.

### Experiment C: Remove the fencing condition

In a temporary copy of the SQL, remove:

```sql
WHERE
    fenced_resource_state.last_fencing_token
    < EXCLUDED.last_fencing_token
```

With the condition removed, an older token could overwrite a newer token.

**Root cause:** The database no longer checks whether the writer is stale.

**Fix:** Restore the condition. Do not use the deliberately broken query in the real service.

---

## 10. Apply Fencing to BullMQ Workers

The fencing service is now implemented, but we have not yet wired it into your production worker lifecycle.

The conceptual order is:

1. Acquire the Redis lock.
2. If acquisition fails, do not enter the protected section.
3. Allocate a fencing token from PostgreSQL.
4. Perform the protected operation using that token.
5. Ensure the downstream database checks the token atomically.
6. Release the Redis lock using its ownership token.

Pseudocode:

```ts
const lockToken = await distributedLockService.acquire(
  resourceKey,
  ttlMs
);

if (!lockToken) {
  throw new Error("Resource is already locked");
}

try {
  const fencingToken =
    await fencingTokenService.allocateToken(resourceKey);

  const result =
    await fencingTokenService.applyFencedWrite(
      resourceKey,
      fencingToken,
      operationId
    );

  if (!result.accepted) {
    throw new Error("Fenced write rejected");
  }
} finally {
  await distributedLockService.release(
    resourceKey,
    lockToken
  );
}
```

This is a conceptual example, not a complete production worker. In a real worker, account for release errors, BullMQ retries, idempotency, transaction boundaries, and how the business payload is persisted.

### An important limitation

Fencing protects against an older token once the downstream resource has accepted a newer one. If an old owner resumes after its lease expires but before a newer token has been issued or accepted, the database may not yet know that the old owner is stale.

For stricter correctness, choose an appropriate coordination and transaction strategy for the protected resource. Do not assume a fencing token alone enforces the Redis lease's wall-clock expiration.

---

## 11. Production Considerations

### A. Fencing tokens are not idempotency keys

A fencing token orders owners. An idempotency key identifies a business operation across retries.

You may need both:

- A fencing token to reject stale writers.
- An idempotency key to prevent the same business effect from being applied twice.

### B. Do not generate fencing tokens using ordinary application memory

A process-local counter resets when the process restarts and is not shared across workers. Use an authoritative atomic counter or another source that provides the required ordering guarantees.

### C. Do not use random UUIDs as ordered fencing tokens

UUIDs are useful for lock ownership. They do not inherently tell you which owner is newer.

### D. The downstream system must enforce the token

Generating a token and attaching it to a log entry does not protect state.

The actual write path must reject stale tokens. If the protected resource is an external API, that API must also enforce a suitable version or fencing mechanism; a PostgreSQL check cannot protect an unrelated system that ignores it.

### E. Keep the business update atomic

In this lecture, the conditional PostgreSQL statement is the enforcement point.

For a real application, put the token check and relevant business-state update in the same transaction or atomic statement. Do not check the token in one query and perform an unguarded update later.

### F. Monitor rejected writes

A rejected fencing token may indicate:

- A stale worker resumed after a pause.
- A lease expired before work finished.
- Competing jobs are processing the same resource.
- A retry or recovery path needs attention.

Log the resource identifier, token, operation ID, and rejection reason without exposing sensitive payloads.

---

## 12. Final Checklist

- [ ] Understand why a worker may continue after a Redis lease expires.
- [ ] Understand the difference between locks, leases, and fencing tokens.
- [ ] Created the PostgreSQL migration using the project's migration convention.
- [ ] Created `src/services/fencing-token.service.ts`.
- [ ] Created `tests/fencing-token.service.test.ts`.
- [ ] Verified that token allocation is monotonic for a resource.
- [ ] Verified that stale writes are rejected.
- [ ] Ran the tests and TypeScript build.
- [ ] Applied and verified the migration.
- [ ] Understood why downstream enforcement is essential.
- [ ] Understood why idempotency remains necessary.

## Success Criteria

Lecture 5 is complete when your tests pass, the project builds, and you can explain how a database rejects a stale writer even after its Redis lock has expired.

**Next: Module 3 — Lecture 6: Leader Election.** We will explore how distributed workers coordinate to select one active leader for a task, and why leader election also needs protection against stale leaders.
