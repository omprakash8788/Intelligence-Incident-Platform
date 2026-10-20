
# Module 3 — Distributed Systems
# Lecture 11: Atomic Fencing Enforcement in PostgreSQL

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [Why In-Memory Fencing Is Insufficient](#2-why-in-memory-fencing-is-insufficient)
3. [The Race Condition We Must Prevent](#3-the-race-condition-we-must-prevent)
4. [Design the PostgreSQL Resource](#4-design-the-postgresql-resource)
5. [Create the Demo Table](#5-create-the-demo-table)
6. [Implement the Atomic Fenced Write](#6-implement-the-atomic-fenced-write)
7. [Understand the SQL](#7-understand-the-sql)
8. [Verify Fencing in PostgreSQL](#8-verify-fencing-in-postgresql)
9. [Test Two Leadership Tenures](#9-test-two-leadership-tenures)
10. [Test Concurrent Writes](#10-test-concurrent-writes)
11. [Intentionally Break the SQL](#11-intentionally-break-the-sql)
12. [Build and Verification](#12-build-and-verification)
13. [What This Implementation Guarantees](#13-what-this-implementation-guarantees)
14. [Final Folder Structure](#14-final-folder-structure)
15. [Success Criteria](#15-success-criteria)
16. [Next Lecture](#16-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a JavaScript `Map` cannot enforce fencing across multiple application instances.
- How PostgreSQL can reject stale fencing tokens atomically.
- How `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` works.
- Why the token comparison and protected data update must happen in the same SQL statement.
- How to verify stale-write rejection using real PostgreSQL.
- Why a successful database write is not, by itself, proof that your complete leader-election system is production-safe.

**Scope:** This is an isolated PostgreSQL exercise. We will not edit `src/workers.ts`, register a worker, start a leader runtime, or change the existing leader-election service.

## 2. Why In-Memory Fencing Is Insufficient

In Lecture 10, we implemented a fencing policy using a JavaScript `Map`.

That was useful for learning, but consider two Node.js processes:

```text
Node.js Process A                 Node.js Process B
-----------------                -----------------
Map says token = 41               Map says token = 0

Receives token 41                 Receives token 42

Accepts token 41                  Accepts token 42
```

Each process has its own memory. Process A does not automatically know that process B has already accepted token 42.

The protected resource needs a **shared, authoritative record** of the highest accepted fencing token.

In this lecture, PostgreSQL will serve as that resource.

## 3. The Race Condition We Must Prevent

Imagine a resource named `account-1001`.

1. Leader A receives token `41`.
2. Leader A pauses.
3. Its lease expires.
4. Leader B receives token `42`.
5. Leader B updates the resource.
6. Leader A resumes and attempts an old update.

The database must reject Leader A's stale write.

The key rule is:

```text
incoming token < stored token
    => reject the write

incoming token >= stored token
    => allow the write
```

We allow equal tokens because a single legitimate leadership tenure may perform multiple operations. This does not establish ordering between two different operations carrying the same token.

## 4. Design the PostgreSQL Resource

We will use a dedicated demonstration table rather than modifying an existing business table.

The table contains three fields:

| Column | Purpose |
|---|---|
| `resource_id` | Identifies the protected resource |
| `highest_token` | Highest fencing token accepted for that resource |
| `value` | Demonstration data protected by the fencing rule |

For example:

```text
resource_id  | highest_token | value
-------------+---------------+-------------------
account-1001 | 42            | new-leader-result
```

PostgreSQL will perform the comparison and update as one atomic statement.

## 5. Create the Demo Table

### Step 1 — Create the SQL file

**File: `database/migrations/lecture-11-fencing.sql`**

Create the `database` directory at the project root if it does not already exist. Create the SQL file with this complete content:

```sql
CREATE TABLE IF NOT EXISTS lecture11_fenced_resources (
    resource_id TEXT PRIMARY KEY,
    highest_token BIGINT NOT NULL
        CHECK (highest_token > 0),
    value TEXT NOT NULL
);
```

This table is deliberately named `lecture11_fenced_resources` to keep the exercise separate from existing application data.

### Step 2 — Confirm PostgreSQL is running

Run this from your project root in PowerShell:

```powershell
docker compose ps
```

Find the PostgreSQL container. If it is not running, start the service using the service name from your `docker-compose.yml`:

```powershell
docker compose up -d postgres
```

If your Compose service has a different name, use that name instead.

### Step 3 — Apply the SQL file

The previously used local database configuration was:

- Container: `production-intelligence-postgres`
- Database: `production_intelligence`
- User: `postgres`

If those values are still correct, run:

```powershell
Get-Content .\database\lecture-11-fencing.sql |
  docker exec -i production-intelligence-postgres psql -v ON_ERROR_STOP=1 -U postgres -d production_intelligence
```

If your container name, database, or user has changed, substitute your actual configuration.

Expected result includes:

```text
CREATE TABLE
```

This is a standalone learning table, not an application migration. Do not modify existing migrations for this exercise.

## 6. Implement the Atomic Fenced Write

### Step 1 — Create the service

**File: `src/services/postgres-fenced-write.service.ts`**

Create this file with the complete code below.

It uses the existing PostgreSQL pool import convention from the project context. If your current `src/database/pool.ts` exports the pool differently, match its actual export rather than changing the pool configuration.

```typescript
import { pool } from "../database/pool.js";

export interface FencedWriteInput {
  resourceId: string;
  fencingToken: number;
  value: string;
}

export interface FencedWriteResult {
  accepted: boolean;
  resourceId: string;
  highestToken: string;
  value: string;
}

interface FencedResourceRow {
  resource_id: string;
  highest_token: string;
  value: string;
}

export const writeFencedResource = async (
  input: FencedWriteInput
): Promise<FencedWriteResult> => {
  const {
    resourceId,
    fencingToken,
    value
  } = input;

  if (resourceId.trim().length === 0) {
    throw new Error("resourceId must not be empty");
  }

  if (
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1
  ) {
    throw new Error(
      "fencingToken must be a positive safe integer"
    );
  }

  const result = await pool.query<FencedResourceRow>(
    `
      INSERT INTO lecture11_fenced_resources (
        resource_id,
        highest_token,
        value
      )
      VALUES ($1, $2, $3)

      ON CONFLICT (resource_id)
      DO UPDATE SET
        highest_token = EXCLUDED.highest_token,
        value = EXCLUDED.value

      WHERE
        EXCLUDED.highest_token
          >= lecture11_fenced_resources.highest_token

      RETURNING
        resource_id,
        highest_token,
        value
    `,
    [
      resourceId,
      fencingToken,
      value
    ]
  );

  if (result.rowCount === 0) {
    const current = await pool.query<{
      highest_token: string;
    }>(
      `
        SELECT highest_token
        FROM lecture11_fenced_resources
        WHERE resource_id = $1
      `,
      [resourceId]
    );

    if (current.rowCount === 0) {
      throw new Error(
        "Resource disappeared after fenced write rejection"
      );
    }

    return {
      accepted: false,
      resourceId,
      highestToken: current.rows[0].highest_token,
      value
    };
  }

  const row = result.rows[0];

  return {
    accepted: true,
    resourceId: row.resource_id,
    highestToken: row.highest_token,
    value: row.value
  };
};
```

### Important implementation note

PostgreSQL's `BIGINT` is returned as a string by the standard `pg` driver in common configurations. The service therefore represents `highestToken` as a string in its result type.

The input token is validated as a JavaScript safe integer because this implementation accepts a `number`. If your fencing-token domain must exceed JavaScript's safe-integer range, use a validated `bigint` or decimal-string representation throughout instead.

Also note that the rejected-write response performs a second query to retrieve the current token. Another transaction may update the resource between those statements. The returned token is therefore informational; it is not a guaranteed snapshot of the exact token at the instant of rejection.

**The protection itself remains in the first SQL statement.** The second query does not decide whether the write is accepted.

## 7. Understand the SQL

The most important part is:

```sql
INSERT INTO lecture11_fenced_resources (
    resource_id,
    highest_token,
    value
)
VALUES ($1, $2, $3)

ON CONFLICT (resource_id)
DO UPDATE SET
    highest_token = EXCLUDED.highest_token,
    value = EXCLUDED.value

WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token

RETURNING
    resource_id,
    highest_token,
    value;
```

### 7.1 What does `EXCLUDED` mean?

In PostgreSQL's `INSERT ... ON CONFLICT` statement, `EXCLUDED` refers to the row proposed for insertion that conflicted with an existing row.

For example, a proposed write may contain:

```text
resource_id = account-1001
highest_token = 41
value = old-leader-result
```

If `account-1001` already exists, PostgreSQL evaluates the conflict-update rule.

### 7.2 What does the `WHERE` condition do?

```sql
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
```

Suppose the stored token is `42` and the proposed token is `41`.

```text
41 >= 42
false
```

PostgreSQL does not perform the conflicting row update. Since no row is returned, the service identifies the write as rejected.

Now suppose the proposed token is `43`.

```text
43 >= 42
true
```

The row is updated to token `43` and the new value.

### 7.3 Why is this atomic?

PostgreSQL coordinates conflicting writes to the same unique key and evaluates the conflict-update condition as part of the statement.

You must not replace this with two independent application operations:

```text
1. SELECT the current token
2. Compare the token in JavaScript
3. UPDATE the value
```

That sequence has a race: another transaction can advance the token between the `SELECT` and the `UPDATE`.

## 8. Verify Fencing in PostgreSQL

We will first test the SQL directly. This lets us validate the database behavior before relying on the TypeScript service.

### Step 1 — Open a PostgreSQL session

Run:

```powershell
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```

Use the actual container name if it differs.

### Step 2 — Clear only the demonstration row

Inside `psql`, run:

```sql
DELETE FROM lecture11_fenced_resources
WHERE resource_id = 'account-1001';
```

This removes only the demonstration row for this resource ID.

### Step 3 — Insert the first leadership result

```sql
INSERT INTO lecture11_fenced_resources (
    resource_id,
    highest_token,
    value
)
VALUES (
    'account-1001',
    41,
    'leader-A'
)
ON CONFLICT (resource_id)
DO UPDATE SET
    highest_token = EXCLUDED.highest_token,
    value = EXCLUDED.value
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
RETURNING
    resource_id,
    highest_token,
    value;
```

Expected result:

```text
account-1001 | 41 | leader-A
```

### Step 4 — Let the newer leader write

Run the same SQL statement, changing the proposed token and value:

```sql
INSERT INTO lecture11_fenced_resources (
    resource_id,
    highest_token,
    value
)
VALUES (
    'account-1001',
    42,
    'leader-B'
)
ON CONFLICT (resource_id)
DO UPDATE SET
    highest_token = EXCLUDED.highest_token,
    value = EXCLUDED.value
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
RETURNING
    resource_id,
    highest_token,
    value;
```

Expected result:

```text
account-1001 | 42 | leader-B
```

### Step 5 — Simulate the stale leader

Run the statement again with token `41` and value `stale-leader-A`:

```sql
INSERT INTO lecture11_fenced_resources (
    resource_id,
    highest_token,
    value
)
VALUES (
    'account-1001',
    41,
    'stale-leader-A'
)
ON CONFLICT (resource_id)
DO UPDATE SET
    highest_token = EXCLUDED.highest_token,
    value = EXCLUDED.value
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
RETURNING
    resource_id,
    highest_token,
    value;
```

Expected result: **zero rows returned**.

The database did not accept the stale write.

### Step 6 — Confirm the final state

Run:

```sql
SELECT
    resource_id,
    highest_token,
    value
FROM lecture11_fenced_resources
WHERE resource_id = 'account-1001';
```

Expected result:

```text
account-1001 | 42 | leader-B
```

The value must remain `leader-B`, not `stale-leader-A`.

Exit `psql`:

```sql
\q
```

## 9. Test Two Leadership Tenures

The database exercise demonstrates the core rule, but the TypeScript service should also be exercised.

### Step 1 — Use a temporary runner

**File: `src/lecture-11-fencing-demo.ts`**

Create this temporary runner. It is an independent script and is not imported by `server.ts` or `workers.ts`.

```typescript
import { pool } from "./database/pool.js";
import {
  writeFencedResource
} from "./services/postgres-fenced-write.service.js";

const resourceId = "lecture-11-demo-account";

const run = async (): Promise<void> => {
  try {
    const newerLeader = await writeFencedResource({
      resourceId,
      fencingToken: 42,
      value: "new-leader-result"
    });

    console.log("New leader:", newerLeader);

    const staleLeader = await writeFencedResource({
      resourceId,
      fencingToken: 41,
      value: "stale-leader-result"
    });

    console.log("Stale leader:", staleLeader);

    const finalState = await pool.query(
      `
        SELECT
          resource_id,
          highest_token,
          value
        FROM lecture11_fenced_resources
        WHERE resource_id = $1
      `,
      [resourceId]
    );

    console.log("Final database state:", finalState.rows);
  } finally {
    await pool.end();
  }
};

run().catch((error: unknown) => {
  console.error("Lecture 11 demo failed:", error);
  process.exitCode = 1;
});
```

This runner assumes your project pool exports `pool` and that its configuration connects to the database containing `lecture11_fenced_resources`.

### Step 2 — Run it

If your project uses `tsx`, run:

```powershell
npx tsx src/lecture-11-fencing-demo.ts
```

The first run should accept token `42` and reject token `41`.

Expected final database value:

```text
new-leader-result
```

The demo uses token `42` deliberately. It does not reset or delete the existing demonstration row.

If the table does not exist, apply the SQL setup from Section 5 first.

### Step 3 — Clean up the temporary runner

After verifying the behavior, delete:

```text
src/lecture-11-fencing-demo.ts
```

Keep these two learning files:

```text
src/services/postgres-fenced-write.service.ts
database/lecture-11-fencing.sql
```

The table may remain until you choose to clean up the exercise. Do not drop it if you want to retain the demonstration data.

## 10. Test Concurrent Writes

Now consider two operations that reach PostgreSQL at almost the same time:

- Write A uses token `41`.
- Write B uses token `42`.

The conflict-update condition protects the resource regardless of which statement reaches the conflict first.

### Case A — Token 41 commits first

1. Token 41 creates or updates the row.
2. Token 42 subsequently updates it.
3. The final token is 42.

### Case B — Token 42 commits first

1. Token 42 creates or updates the row.
2. Token 41 subsequently encounters the existing row.
3. The `WHERE` condition rejects token 41.
4. The final token remains 42.

In both cases, the lower token cannot overwrite the higher token.

This is the important safety property. We are not promising that the lower-token request always finishes first or that every request receives a successful response.

**Concurrency limitation:** This reasoning applies to the protected row and this SQL statement. It does not make unrelated side effects atomic, and it does not guarantee ordering between two writes using the same token.

## 11. Intentionally Break the SQL

We will now remove the fencing condition temporarily.

### Step 1 — Modify the service

**File: `src/services/postgres-fenced-write.service.ts`**

Find the `ON CONFLICT` clause and temporarily remove this part:

```sql
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
```

Do not remove the `ON CONFLICT` clause or the `SET` expressions.

### Step 2 — Run the demo again

```powershell
npx tsx src/lecture-11-fencing-demo.ts
```

If you deleted the temporary runner in Section 9, recreate it before this experiment.

Because the `WHERE` condition is gone, the stale write can overwrite the resource with token `41`. This demonstrates why the condition is essential.

### Step 3 — Restore the correct SQL

Restore:

```sql
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
```

Run the demo again. The stale write should be rejected, and the final value should remain `new-leader-result`.

Do not leave the broken SQL in your service.

## 12. Build and Verification

Run the focused checks first.

### Step 1 — TypeScript build

From the project root:

```powershell
npm run build
```

If it fails, inspect the exact compiler error. In particular, confirm that the pool export and the `pg` result types match your actual project.

### Step 2 — Existing tests

```powershell
npm run test:run
```

The service in this lecture is database-backed, so the direct PostgreSQL checks are also necessary. A successful unit-test suite alone does not establish that the SQL works against your running database.

### Step 3 — Check the final database state

```sql
SELECT resource_id, highest_token, value
FROM lecture11_fenced_resources
WHERE resource_id = 'lecture-11-demo-account';
```

Confirm that the stale token did not replace the newer leader's value.

Do not claim the build or tests passed until you have actually run them and seen the results.

## 13. What This Implementation Guarantees

### It does guarantee

- The token comparison and conflicting-row update occur in one PostgreSQL statement.
- A token lower than the stored token cannot update that row through this statement.
- Two conflicting writes are coordinated by PostgreSQL.
- The resource stores the highest accepted token.

### It does not guarantee

- That the leader-election service issues correct, strictly increasing tokens.
- That every application writer follows this fencing rule.
- That unrelated database updates or external API calls are protected.
- That two writes using the same token execute in the intended business order.
- That the leader runtime is running or has been integrated into your application.
- That this isolated demonstration is a complete production implementation.

For production, every relevant write path must enforce fencing. If a business operation updates multiple tables, its token checks and business changes may need to share a transaction. For external systems, the external resource must itself support an equivalent conditional-write or fencing mechanism; a PostgreSQL check cannot prevent an already-sent stale HTTP request from taking effect elsewhere.

## 14. Final Folder Structure

After completing the lecture and deleting the temporary runner, the relevant files should look like this:

```text
production-intelligence-platform/
├── database/
│   └── lecture-11-fencing.sql
├── src/
│   ├── database/
│   │   └── pool.ts                         # Existing; unchanged
│   ├── services/
│   │   ├── postgres-fenced-write.service.ts # NEW
│   │   └── leader-election.service.ts      # Existing; unchanged
│   └── workers.ts                          # Unchanged
└── tests/
    └── ...                                 # Existing tests unchanged
```

The `database/lecture-11-fencing.sql` file is a standalone exercise script, not a migration registered with your application's migration system.

## 15. Success Criteria

- [ ] Created the isolated PostgreSQL demo table.
- [ ] Created `src/services/postgres-fenced-write.service.ts`.
- [ ] Successfully inserted a row using token 41.
- [ ] Successfully updated the row using token 42.
- [ ] Confirmed that token 41 cannot overwrite token 42.
- [ ] Confirmed that the final database value is still the newer leader's result.
- [ ] Removed the temporary SQL bug after the experiment.
- [ ] Ran the build and existing tests, investigating any failures.
- [ ] Did not modify `src/workers.ts`.
- [ ] Understand the distinction between database-level fencing and complete leader-runtime integration.

## 16. Next Lecture

**Module 3 — Lecture 12: Concurrent Failure Testing and Stale-Leader Recovery**

Next, we will test failure cases more rigorously: simultaneous writes, lease loss during work, retry behavior, and the difference between rejecting a stale write and safely recovering the leader runtime. We will keep the tests isolated until the existing service and runtime implementations have been verified against your actual files.
