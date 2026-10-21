
# Module 3 — Distributed Systems
# Lecture 12: Concurrent Failure Testing and Stale-Leader Recovery

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [What We Are Testing](#2-what-we-are-testing)
3. [Important Project Structure](#3-important-project-structure)
4. [Understand the Concurrent Failure Scenario](#4-understand-the-concurrent-failure-scenario)
5. [Create the PostgreSQL Integration Test](#5-create-the-postgresql-integration-test)
6. [Run the Integration Test](#6-run-the-integration-test)
7. [Test Stale-Leader Recovery](#7-test-stale-leader-recovery)
8. [Intentionally Break the Fencing Rule](#8-intentionally-break-the-fencing-rule)
9. [Verify the Database State](#9-verify-the-database-state)
10. [What the Test Proves](#10-what-the-test-proves)
11. [What the Test Does Not Prove](#11-what-the-test-does-not-prove)
12. [Final Folder Structure](#12-final-folder-structure)
13. [Success Criteria](#13-success-criteria)
14. [Next Lecture](#14-next-lecture)

---

## 1. Learning Objectives

In this lecture, we will test the PostgreSQL fencing implementation from Lecture 11 under concurrent writes.

You will learn to:

- Test two writers attempting to update the same protected resource.
- Verify that the final database state retains the highest accepted fencing token.
- Test a stale leader attempting a write after a newer leader has written.
- Keep database integration tests separate from ordinary unit tests.
- Understand the difference between testing resource protection and testing leader-runtime recovery.

**Scope:** We are testing the fenced-write service directly. We are not starting the leader runtime, registering a worker, or modifying `src/workers.ts`.

## 2. What We Are Testing

Suppose two leaders are operating on the same resource.

| Leader | Fencing token | Intended value |
|---|---:|---|
| Leader A | 41 | `old-leader-result` |
| Leader B | 42 | `new-leader-result` |

Both attempt their writes concurrently.

Regardless of which request reaches PostgreSQL first, the final stored token must be `42`, and the final stored value must be `new-leader-result`.

There are two valid execution orders:

**Case A — Token 41 is processed first**

1. PostgreSQL accepts token 41.
2. PostgreSQL accepts token 42.
3. The final token is 42.

**Case B — Token 42 is processed first**

1. PostgreSQL accepts token 42.
2. PostgreSQL rejects token 41.
3. The final token is 42.

The test must verify the final database state, not assume a particular request finishes first.

## 3. Important Project Structure

Your existing project already contains database migrations under:

`src/database/migrations/`

You have existing fencing-related and distributed-systems migration files in that directory.

**Do not create another migration or another table for this lecture.** We will reuse the table and service introduced in Lecture 11.

The integration test assumes these existing files are present:

```text
src/
├── database/
│   ├── migrations/
│   │   └── lecture-11-fencing.sql
│   └── pool.ts
└── services/
    └── postgres-fenced-write.service.ts
```

The exact migration filename may differ in your working tree. Use the migration or SQL file that actually creates `lecture11_fenced_resources`.

If your existing fencing migration creates a differently named table or defines different columns, adapt the test to the actual schema before running it. Do not create a duplicate table to work around a naming mismatch.

## 4. Understand the Concurrent Failure Scenario

The resource has this initial state:

```text
resource_id  = lecture-12-concurrent-demo
highest_token = 0 (no row exists yet)
```

Two operations start:

```text
Writer A                       Writer B
--------                       --------
Token: 41                      Token: 42
Value: old-leader-result       Value: new-leader-result
       \                         /
        \                       /
         Both write to PostgreSQL
                    |
                    v
       Highest token must be 42
       Final value must be new-leader-result
```

The important point is that the test does not decide which writer wins the race. The database's atomic fencing rule decides which writes are accepted.

## 5. Create the PostgreSQL Integration Test

### Step 1 — Create the test file

**File: `tests/postgres-fenced-write.integration.test.ts`**

Create the file with this complete content.

```typescript
import {
  afterAll,
  describe,
  expect,
  it
} from "vitest";

import { pool } from "../src/database/pool.js";

import {
  writeFencedResource
} from "../src/services/postgres-fenced-write.service.js";

const runPostgresIntegrationTests =
  process.env.RUN_POSTGRES_INTEGRATION === "true";

describe.skipIf(!runPostgresIntegrationTests)(
  "PostgreSQL fenced-write integration tests",
  () => {
    const resourceId =
      "lecture-12-concurrent-demo";

    afterAll(async () => {
      await pool.query(
        `
          DELETE FROM lecture11_fenced_resources
          WHERE resource_id = $1
        `,
        [resourceId]
      );
    });

    it(
      "preserves the higher fencing token under concurrent writes",
      async () => {
        await pool.query(
          `
            DELETE FROM lecture11_fenced_resources
            WHERE resource_id = $1
          `,
          [resourceId]
        );

        const results = await Promise.all([
          writeFencedResource({
            resourceId,
            fencingToken: 41,
            value: "old-leader-result"
          }),

          writeFencedResource({
            resourceId,
            fencingToken: 42,
            value: "new-leader-result"
          })
        ]);

        expect(results).toHaveLength(2);

        const finalState = await pool.query<{
          resource_id: string;
          highest_token: string;
          value: string;
        }>(
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

        expect(finalState.rowCount).toBe(1);

        expect(finalState.rows[0]).toEqual({
          resource_id: resourceId,
          highest_token: "42",
          value: "new-leader-result"
        });
      }
    );

    it(
      "rejects a stale write after the newer leader has written",
      async () => {
        const staleScenarioId =
          "lecture-12-stale-leader-demo";

        try {
          await pool.query(
            `
              DELETE FROM lecture11_fenced_resources
              WHERE resource_id = $1
            `,
            [staleScenarioId]
          );

          const newerLeader = await writeFencedResource({
            resourceId: staleScenarioId,
            fencingToken: 42,
            value: "new-leader-result"
          });

          expect(newerLeader.accepted).toBe(true);

          const staleLeader = await writeFencedResource({
            resourceId: staleScenarioId,
            fencingToken: 41,
            value: "old-leader-result"
          });

          expect(staleLeader.accepted).toBe(false);

          const finalState = await pool.query<{
            highest_token: string;
            value: string;
          }>(
            `
              SELECT
                highest_token,
                value
              FROM lecture11_fenced_resources
              WHERE resource_id = $1
            `,
            [staleScenarioId]
          );

          expect(finalState.rowCount).toBe(1);

          expect(finalState.rows[0]).toEqual({
            highest_token: "42",
            value: "new-leader-result"
          });
        } finally {
          await pool.query(
            `
              DELETE FROM lecture11_fenced_resources
              WHERE resource_id = $1
            `,
            [staleScenarioId]
          );
        }
      }
    );
  }
);
```

### Step 2 — Understand why integration tests are skipped by default

The following condition controls whether these tests run:

```typescript
const runPostgresIntegrationTests =
  process.env.RUN_POSTGRES_INTEGRATION === "true";
```

We deliberately avoid running database integration tests automatically with every ordinary unit-test run. Integration tests require a reachable PostgreSQL instance and the correct schema.

When the environment variable is not set to `"true"`, Vitest skips this test suite.

This does not mean the database tests passed. A skipped test has not verified the database behavior.

### Step 3 — Why do we delete test rows?

Each test uses a dedicated resource ID and deletes its test data afterward.

This avoids depending on rows left by previous test runs.

The cleanup is limited to the two test resource IDs. It does not truncate the table, drop the table, or delete other application data.

## 6. Run the Integration Test

### Step 1 — Confirm PostgreSQL is running

From your project root, run:

```powershell
docker compose ps
```

Confirm the PostgreSQL container is running.

If the PostgreSQL service is stopped, start it using the service name defined in your Compose configuration:

```powershell
docker compose up -d postgres
```

If your Compose service has another name, use that name instead.

### Step 2 — Confirm the table exists

Use the container and database names that match your environment. Based on your earlier project commands:

```powershell
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```

Inside `psql`, run:

```sql
SELECT to_regclass('public.lecture11_fenced_resources');
```

If the table exists in the `public` schema, PostgreSQL returns:

```text
lecture11_fenced_resources
```

If it returns `NULL`, stop here. Inspect your existing migration files and determine the actual table name and schema. Do not create a duplicate table blindly.

Exit `psql`:

```sql
\q
```

### Step 3 — Run the focused integration test

In PowerShell, run:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "true"
npm run test:run -- tests/postgres-fenced-write.integration.test.ts
```

Expected result: both integration tests pass.

If your project uses a different test script, use the existing script defined in `package.json`.

### Step 4 — Reset the environment variable

After the focused run, you can remove the variable from the current PowerShell session:

```powershell
Remove-Item Env:RUN_POSTGRES_INTEGRATION -ErrorAction SilentlyContinue
```

This prevents the variable from unexpectedly enabling the integration tests in later commands within that session.

## 7. Test Stale-Leader Recovery

There is an important distinction between two types of recovery.

### Resource-level protection

This is what our tests verify:

1. Leader A holds token 41.
2. Leader B takes over with token 42.
3. Leader B writes successfully.
4. Leader A resumes and attempts its stale write.
5. PostgreSQL rejects the stale write.

### Leader-runtime recovery

A complete leader runtime must also handle lease loss correctly:

1. Stop performing leader-only work after leadership is lost.
2. Avoid starting duplicate leader-only activity.
3. Cancel or safely drain ongoing work where possible.
4. Release resources when appropriate.
5. Retry leadership acquisition according to its policy.

The PostgreSQL tests do **not** prove those runtime behaviors. They test the resource's fencing boundary.

We will test the leader runtime separately after its actual implementation and unit tests are verified.

## 8. Intentionally Break the Fencing Rule

This exercise demonstrates why the database condition matters.

### Step 1 — Break the service temporarily

**File: `src/services/postgres-fenced-write.service.ts`**

Find this SQL condition:

```sql
WHERE
    EXCLUDED.highest_token
      >= lecture11_fenced_resources.highest_token
```

Temporarily remove the condition from the `ON CONFLICT ... DO UPDATE` clause.

Do not leave this change in place.

### Step 2 — Run the integration tests

```powershell
$env:RUN_POSTGRES_INTEGRATION = "true"
npm run test:run -- tests/postgres-fenced-write.integration.test.ts
```

At least the stale-write scenario should expose the problem: without the condition, token 41 can overwrite the row after token 42 has been stored.

### Step 3 — Restore the correct condition

Restore the SQL condition exactly as shown above.

Run the integration tests again:

```powershell
npm run test:run -- tests/postgres-fenced-write.integration.test.ts
```

Expected result: both tests pass.

**Never commit or deploy the intentionally broken version.**

## 9. Verify the Database State

After the tests run, you can inspect the table:

```powershell
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```

Inside `psql`:

```sql
SELECT
    resource_id,
    highest_token,
    value
FROM lecture11_fenced_resources
WHERE resource_id IN (
    'lecture-12-concurrent-demo',
    'lecture-12-stale-leader-demo'
);
```

The tests clean up their rows, so the query may return zero rows. That is expected if the tests completed their cleanup successfully.

To inspect a persistent row from your earlier Lecture 11 exercise, use its resource ID instead.

Exit with:

```sql
\q
```

## 10. What the Test Proves

If both tests pass against the intended PostgreSQL database, we have verified:

- Concurrent writes with tokens 41 and 42 leave token 42 as the highest accepted token.
- The newer leader's value remains intact.
- A stale write after a newer write is rejected.
- The database, rather than a process-local `Map`, enforces the tested rule.

The first test deliberately does not assert which concurrent request completes first. It asserts the invariant that matters: the final state must contain token 42 and the corresponding value.

## 11. What the Test Does Not Prove

Passing these tests does not establish that the complete distributed system is production-ready.

They do not prove:

- The leader-election service always issues strictly increasing tokens.
- A lease renewal failure always stops leader-only work.
- Every database write path validates the fencing token.
- External APIs reject stale requests.
- Retries are idempotent.
- Two operations with the same fencing token execute in business order.
- The existing leader runtime and lease-provider adapter have correct lifecycle behavior.

Those require additional tests and, where necessary, integration with the actual application architecture.

## 12. Final Folder Structure

After this lecture, the relevant structure should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/
│   │   │   └── ...                         # Existing migrations
│   │   └── pool.ts                          # Existing
│   ├── services/
│   │   └── postgres-fenced-write.service.ts # From Lecture 11
│   └── workers.ts                           # Unchanged
└── tests/
    └── postgres-fenced-write.integration.test.ts # NEW
```

This lecture does not require a new migration, a new table, or changes to application startup.

## 13. Success Criteria

- [ ] Confirmed the existing fencing table and schema.
- [ ] Created `tests/postgres-fenced-write.integration.test.ts`.
- [ ] Ran the integration tests against PostgreSQL.
- [ ] Verified the final token is 42 after concurrent writes.
- [ ] Verified a stale token cannot overwrite a newer leader's value.
- [ ] Temporarily broke the fencing condition and observed the failure.
- [ ] Restored the correct SQL condition.
- [ ] Confirmed the tests clean up only their own demonstration rows.
- [ ] Left `src/workers.ts` unchanged.
- [ ] Distinguished resource-level fencing from leader-runtime recovery.

## 14. Next Lecture

**Module 3 — Lecture 13: Lease Loss During In-Flight Work**

Next, we will study what happens when a leader loses its lease while a task is already running. We will distinguish stopping future work from cancelling an in-flight operation, define safe behavior for ongoing tasks, and design tests for the failure cases without prematurely wiring anything into `src/workers.ts`.
