
# Module 3 — Lecture 6: Leader Election

## Table of Contents

1. Learning objectives
2. The problem: multiple instances, one leader
3. Leader election vs. distributed locks
4. Design the leadership lease
5. Create the PostgreSQL migration
6. Implement the leader-election service
7. Write unit tests
8. Build and verify
9. Break it intentionally
10. Understand crash recovery and split-brain risks
11. Production integration strategy
12. Final checklist

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why distributed applications sometimes need one active leader.
- How leader election differs from ordinary job processing.
- How PostgreSQL can coordinate competing leader candidates.
- How leases allow another instance to become leader after a failure.
- Why the database clock is useful for evaluating lease expiration.
- How fencing tokens distinguish successive leadership terms.
- Why an expired leader must not be allowed to renew its old lease.
- Why leadership alone does not make every external side effect safe.

We will implement a PostgreSQL-backed leadership lease using your existing Node.js, TypeScript, PostgreSQL, and Vitest stack.

We will not add another Redis instance, replace your existing worker lifecycle, or change your Docker Compose configuration.

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Before starting, confirm that the project builds and your existing tests pass.

---

## 2. The Problem: Multiple Instances, One Leader

Imagine that your Production Intelligence platform runs three application instances:

```text
                  PostgreSQL
                      |
          +-----------+-----------+
          |           |           |
          v           v           v
       Instance A  Instance B  Instance C
```

All three instances are healthy. However, suppose the platform must run a periodic reconciliation task only once at a time.

If all three independently start that task, you might get:

- Duplicate incident reconciliation.
- Multiple notifications for the same incident.
- Redundant expensive computations.
- Conflicting attempts to update shared state.

We need a coordination mechanism that determines which instance currently holds leadership.

### What should happen?

Initially:

```text
Instance A: LEADER
Instance B: FOLLOWER
Instance C: FOLLOWER
```

If A crashes and its lease expires:

```text
Instance A: UNAVAILABLE
Instance B: CANDIDATE → LEADER
Instance C: FOLLOWER
```

This is leader election.

The important requirement is not that the same instance remains leader forever. It is that leadership can be reassigned when the current lease expires.

---

## 3. Leader Election vs. Distributed Locks

These concepts are related, but they solve different problems.

| Distributed lock | Leader election |
|---|---|
| Protects a critical section | Selects an active coordinator |
| Often acquired for one operation | Usually maintained through recurring lease renewals |
| Released when work finishes | Maintained while the instance remains leader |
| Contention is often short-lived | Leadership may last for minutes or hours |
| Example: protect report generation | Example: coordinate periodic reconciliation |

A leader election system often uses a lock or lease underneath.

For this lecture, PostgreSQL will act as the authoritative coordinator.

### Why PostgreSQL?

Your application already uses PostgreSQL. We can use one database row to coordinate competing instances.

PostgreSQL provides atomic inserts, conditional updates, row-level concurrency control, and a database clock. These capabilities let us implement a lease without relying on each application's local clock.

This is a useful design for an application whose instances already share the same PostgreSQL database. It is not the only possible leader-election architecture.

---

## 4. Design the Leadership Lease

Each election has a unique name, such as:

```text
incident-reconciliation
```

The database stores:

- `election_name`: which leadership role is being coordinated.
- `leader_id`: which application instance currently owns it.
- `lease_expires_at`: when the current lease expires.
- `fencing_token`: the monotonically increasing leadership term.

For example:

| Election | Leader | Token | Lease |
|---|---|---:|---|
| incident-reconciliation | instance-A | 1 | Active |
| incident-reconciliation | instance-B | 2 | Active after A's lease expires |

The fencing token increases when a new leadership term is granted.

A renewal by the existing leader retains its token. A new leader receives a newer token.

### The three operations

**Acquire leadership**

Attempt to become leader only if no lease exists or the previous lease has expired.

**Renew leadership**

Extend the lease only if the instance still owns the current, unexpired lease with the matching fencing token.

**Release leadership**

Expire the lease only if the caller still owns the current lease.

These ownership checks are essential. A stale instance must not renew or release a newer leader's lease.

---

## 5. Create the PostgreSQL Migration

### 5.1 Create the migration file

**File:** `src/database/migrations/20261019_create_distributed_leader_leases.sql`

**Action:** Create a new migration. If this filename already exists, use a unique filename consistent with your project's migration convention. Never overwrite a migration that has already been applied.

```sql
CREATE TABLE IF NOT EXISTS distributed_leader_leases (
    election_name TEXT PRIMARY KEY,

    leader_id TEXT NOT NULL,

    lease_expires_at TIMESTAMPTZ NOT NULL,

    fencing_token BIGINT NOT NULL
        CHECK (fencing_token > 0),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Why is the election name the primary key?

There should be only one authoritative lease row for each election name.

For example, every instance competing for `incident-reconciliation` operates on the same row.

### Why retain the row after releasing leadership?

We need the fencing token to keep increasing across leadership changes.

Deleting the row would reset the counter when the next leader creates it again. Keeping the row preserves the sequence.

---

## 6. Implement the Leader-Election Service

### 6.1 Create the service

**File:** `src/services/leader-election.service.ts`

**Action:** Create this file.

The implementation assumes your existing PostgreSQL pool is exported as `pool` from `src/database/pool.ts`. Reuse that pool. If your project uses a different export name, adapt the import to match the actual file.

```ts
import { pool } from "../database/pool.js";

export interface LeadershipLease {
  electionName: string;
  leaderId: string;
  fencingToken: string;
  leaseExpiresAt: Date;
}

interface LeadershipRow {
  election_name: string;
  leader_id: string;
  fencing_token: string;
  lease_expires_at: Date;
}

export class LeaderElectionService {
  private validateIdentifiers(
    electionName: string,
    leaderId: string
  ): void {
    if (!electionName.trim()) {
      throw new Error("Election name is required");
    }

    if (!leaderId.trim()) {
      throw new Error("Leader ID is required");
    }
  }

  private validateLeaseDuration(
    leaseMs: number
  ): void {
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1000 ||
      leaseMs > 300_000
    ) {
      throw new Error(
        "Lease duration must be between 1000 and 300000 milliseconds"
      );
    }
  }

  private mapLease(
    row: LeadershipRow
  ): LeadershipLease {
    return {
      electionName: row.election_name,
      leaderId: row.leader_id,
      fencingToken: row.fencing_token,
      leaseExpiresAt: row.lease_expires_at
    };
  }

  async acquireLeadership(
    electionName: string,
    leaderId: string,
    leaseMs: number
  ): Promise<LeadershipLease | null> {
    this.validateIdentifiers(electionName, leaderId);
    this.validateLeaseDuration(leaseMs);

    const result = await pool.query<LeadershipRow>(
      `
        INSERT INTO distributed_leader_leases (
          election_name,
          leader_id,
          lease_expires_at,
          fencing_token
        )
        VALUES (
          $1,
          $2,
          clock_timestamp()
            + ($3::double precision * INTERVAL '1 millisecond'),
          1
        )

        ON CONFLICT (election_name)
        DO UPDATE SET
          leader_id = EXCLUDED.leader_id,
          lease_expires_at = clock_timestamp()
            + ($3::double precision * INTERVAL '1 millisecond'),
          fencing_token =
            distributed_leader_leases.fencing_token + 1,
          updated_at = clock_timestamp()

        WHERE
          distributed_leader_leases.lease_expires_at
          <= clock_timestamp()

        RETURNING
          election_name,
          leader_id,
          fencing_token::text AS fencing_token,
          lease_expires_at
      `,
      [electionName, leaderId, leaseMs]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapLease(row);
  }

  async renewLeadership(
    lease: LeadershipLease,
    leaseMs: number
  ): Promise<LeadershipLease | null> {
    this.validateIdentifiers(
      lease.electionName,
      lease.leaderId
    );

    this.validateLeaseDuration(leaseMs);

    const result = await pool.query<LeadershipRow>(
      `
        UPDATE distributed_leader_leases

        SET
          lease_expires_at = clock_timestamp()
            + ($4::double precision * INTERVAL '1 millisecond'),
          updated_at = clock_timestamp()

        WHERE
          election_name = $1
          AND leader_id = $2
          AND fencing_token = $3::bigint
          AND lease_expires_at > clock_timestamp()

        RETURNING
          election_name,
          leader_id,
          fencing_token::text AS fencing_token,
          lease_expires_at
      `,
      [
        lease.electionName,
        lease.leaderId,
        lease.fencingToken,
        leaseMs
      ]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapLease(row);
  }

  async releaseLeadership(
    lease: LeadershipLease
  ): Promise<boolean> {
    this.validateIdentifiers(
      lease.electionName,
      lease.leaderId
    );

    const result = await pool.query(
      `
        UPDATE distributed_leader_leases

        SET
          lease_expires_at = clock_timestamp(),
          updated_at = clock_timestamp()

        WHERE
          election_name = $1
          AND leader_id = $2
          AND fencing_token = $3::bigint
          AND lease_expires_at > clock_timestamp()
      `,
      [
        lease.electionName,
        lease.leaderId,
        lease.fencingToken
      ]
    );

    return result.rowCount === 1;
  }
}

export const leaderElectionService =
  new LeaderElectionService();
```

### 6.2 Understand leadership acquisition

The important SQL condition is:

```sql
WHERE
    distributed_leader_leases.lease_expires_at
    <= clock_timestamp()
```

It applies when a row already exists.

The database can replace the current leader only when the existing lease has expired. PostgreSQL's atomic conflict handling prevents two competing candidates from both successfully taking over the same row at the same time.

If the lease has not expired, the operation returns no row. The service returns `null`.

### 6.3 Understand renewal

The renewal condition checks all three ownership fields:

```sql
WHERE
    election_name = $1
    AND leader_id = $2
    AND fencing_token = $3::bigint
    AND lease_expires_at > clock_timestamp()
```

The leader must still own the same leadership term, and the lease must still be valid.

If the lease has already expired, the old leader cannot renew it. It must compete to acquire leadership again.

If another instance has already taken over, the old leader's token no longer matches.

### 6.4 Understand release

The release operation sets the expiration time to the database's current time, but only when the supplied owner and fencing token match the current row.

It does not delete the row or reset the fencing token.

If release fails because ownership has changed, the caller must not assume that it is still leader.

### 6.5 Why use `clock_timestamp()`?

PostgreSQL's `clock_timestamp()` returns the actual current time when evaluated. It is useful for checking lease expiration against one authoritative database clock.

PostgreSQL's `NOW()` is fixed at the beginning of the current transaction. In a long-running transaction, that can make it unsuitable for some lease-expiration checks.

Keep lease operations short and avoid wrapping unrelated business work in a long database transaction.

---

## 7. Write Unit Tests

These unit tests mock the database pool. They verify the service's validation and interpretation of query results. They do not prove PostgreSQL's real concurrency behavior; we will verify that separately.

### 7.1 Create the test file

**File:** `tests/leader-election.service.test.ts`

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
  LeaderElectionService
} from "../src/services/leader-election.service.js";

describe("LeaderElectionService", () => {
  let service: LeaderElectionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LeaderElectionService();
  });

  it("acquires leadership when the database grants a lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [
        {
          election_name: "incident-reconciliation",
          leader_id: "instance-A",
          fencing_token: "1",
          lease_expires_at: new Date(
            "2026-10-19T12:00:30.000Z"
          )
        }
      ],
      rowCount: 1
    });

    const lease = await service.acquireLeadership(
      "incident-reconciliation",
      "instance-A",
      30_000
    );

    expect(lease).toEqual({
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "1",
      leaseExpiresAt: new Date(
        "2026-10-19T12:00:30.000Z"
      )
    });
  });

  it("returns null when another leader holds the lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const lease = await service.acquireLeadership(
      "incident-reconciliation",
      "instance-B",
      30_000
    );

    expect(lease).toBeNull();
  });

  it("rejects an empty election name", async () => {
    await expect(
      service.acquireLeadership(" ", "instance-A", 30_000)
    ).rejects.toThrow("Election name is required");

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("rejects an invalid lease duration", async () => {
    await expect(
      service.acquireLeadership(
        "incident-reconciliation",
        "instance-A",
        0
      )
    ).rejects.toThrow(
      "Lease duration must be between 1000 and 300000 milliseconds"
    );

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("renews a currently owned lease", async () => {
    const currentLease = {
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "7",
      leaseExpiresAt: new Date(
        "2026-10-19T12:00:30.000Z"
      )
    };

    poolMock.query.mockResolvedValue({
      rows: [
        {
          election_name: currentLease.electionName,
          leader_id: currentLease.leaderId,
          fencing_token: "7",
          lease_expires_at: new Date(
            "2026-10-19T12:01:00.000Z"
          )
        }
      ],
      rowCount: 1
    });

    const renewed = await service.renewLeadership(
      currentLease,
      30_000
    );

    expect(renewed?.fencingToken).toBe("7");
    expect(poolMock.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "AND fencing_token = $3::bigint"
      ),
      [
        currentLease.electionName,
        currentLease.leaderId,
        currentLease.fencingToken,
        30_000
      ]
    );
  });

  it("returns null when renewal no longer owns the lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const renewed = await service.renewLeadership(
      {
        electionName: "incident-reconciliation",
        leaderId: "instance-A",
        fencingToken: "7",
        leaseExpiresAt: new Date()
      },
      30_000
    );

    expect(renewed).toBeNull();
  });

  it("releases a lease only when the database confirms ownership", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 1
    });

    const released = await service.releaseLeadership({
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "7",
      leaseExpiresAt: new Date()
    });

    expect(released).toBe(true);
  });

  it("reports false when release does not match the current lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const released = await service.releaseLeadership({
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "6",
      leaseExpiresAt: new Date()
    });

    expect(released).toBe(false);
  });
});
```

### 7.2 Run the tests

From the project root:

```powershell
npm run test:run -- tests/leader-election.service.test.ts
```

Expected: all eight tests pass.

Then run:

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

If your pool export differs from the one shown, use the actual export in `src/database/pool.ts`. Do not create a second pool.

---

## 8. Build and Verify

### Step 1: Review the migration runner

Inspect `src/database/migrate.ts` and confirm that it recognizes the new SQL migration filename.

Never assume a migration has been applied merely because the file exists.

### Step 2: Apply the migration

```powershell
npm run migrate
```

Expected: the migration runner applies the new table creation successfully.

If the runner rejects the filename, follow its existing naming convention and retry with a new, unique migration filename.

### Step 3: Verify the table

If your Docker Compose service is named `postgres` and your database credentials match your current environment:

```powershell
docker compose exec postgres psql -U postgres -d production_intelligence -c "\d distributed_leader_leases"
```

Adjust the service name, database, and credentials if your actual Compose configuration differs.

### Step 4: Run all tests and build

```powershell
npm run test:run
npm run build
```

Expected: the existing tests and new leader-election tests pass, and TypeScript compiles.

---

## 9. Break It Intentionally

Use your development database only.

### Experiment A: Two instances compete for the same lease

Use the same election name with different leader IDs.

The first candidate should acquire leadership. The second should receive `null` while the first lease is still active.

The relevant database rule is:

```sql
WHERE
    distributed_leader_leases.lease_expires_at
    <= clock_timestamp()
```

**Root cause:** The lease is still valid.

**Fix:** The losing candidate should remain a follower and retry acquisition after a suitable delay.

### Experiment B: The leader crashes

Suppose Instance A holds a lease with a 10-second duration and then crashes.

No renewal occurs. Once the lease expires, Instance B can attempt acquisition and receive a newer fencing token.

**Root cause:** The current lease is no longer valid.

**Fix:** Use a finite lease and retry acquisition with bounded backoff and jitter. Do not require a crashed process to release its lease manually.

### Experiment C: The old leader attempts to renew after takeover

Suppose A held token `1`, its lease expired, and B acquired token `2`.

A then tries to renew using token `1`.

Expected: renewal returns `null`.

**Root cause:** The database row now belongs to B and has a different fencing token.

**Fix:** A must stop acting as leader when renewal fails. It must not keep executing singleton work just because its local state still says `leader`.

### Experiment D: Remove the ownership checks

In a temporary copy of the service, remove the conditions on `leader_id` and `fencing_token` from the renewal query.

A stale instance could then extend a lease that now belongs to a newer leader.

**Root cause:** The database no longer verifies ownership.

**Fix:** Restore the owner and fencing-token predicates. Never use the deliberately broken query in the real service.

---

## 10. Understand Crash Recovery and Split-Brain Risks

### A. Leadership is a lease, not a permanent fact

An instance should treat leadership as temporary permission that must be maintained through successful renewals.

A local variable such as:

```ts
let isLeader = true;
```

is not authoritative. It can become stale when the process loses connectivity or its lease expires.

### B. A renewal failure must stop leader-only work

If renewal returns `null`, the instance should immediately stop initiating new leader-only operations.

It should also cancel or drain work where possible. However, cancellation cannot guarantee that an already-running operation or external request will stop.

### C. Use fencing at the downstream resource

For database updates, use the fencing-token protection from Lecture 5 where appropriate.

For an external service, the external service must enforce a version, fencing token, conditional update, or equivalent mechanism. PostgreSQL cannot protect a separate system that ignores its fencing token.

### D. Do not keep performing work while renewal is uncertain

If the database is unreachable, the instance cannot confirm that its lease is still valid.

A conservative implementation stops starting new leader-only work and treats its leadership as uncertain until it can establish a valid lease again.

### E. Avoid synchronized election retries

If every follower retries at exactly the same interval, many instances can hit PostgreSQL simultaneously.

Use a retry delay with jitter. Keep retry intervals and database load appropriate for the number of instances.

### F. This service is not yet a complete leader runtime

The service implements atomic lease acquisition, renewal, and release. It does not yet provide:

- A renewal scheduler.
- Automatic retry with jitter.
- Leader-state events.
- A graceful stop mechanism for ongoing work.
- Metrics and health integration.
- A complete fencing integration for business writes.

We will integrate these concerns in a later practical exercise rather than hiding them inside this foundational service.

---

## 11. Production Integration Strategy

When you integrate leader election into your existing `src/workers.ts`, use the following lifecycle:

```text
Worker process starts
        |
        v
Try to acquire leadership
        |
        +---- Not acquired ---> Wait with jitter ---> Retry
        |
        v
Leadership acquired
        |
        v
Start leader-only task
        |
        v
Renew lease periodically
        |
        +---- Renewal succeeds ---> Continue
        |
        +---- Renewal fails -----> Stop leader-only work
                                      |
                                      v
                                  Re-elect
```

For your Production Intelligence platform, a potential future use case is periodic reconciliation of stale incident records. Ordinary BullMQ jobs should continue to use the existing worker model; they do not all need a single leader.

Before registering a leader runtime in your existing lifecycle, define:

1. Which task must run under one leader.
2. How often the lease is renewed.
3. How much time remains before lease expiration when renewal begins.
4. What happens if renewal fails.
5. How downstream writes reject stale leadership tokens.
6. How the task stops cleanly during process shutdown.

Do not register an arbitrary singleton task merely because the application has a leader-election service.

---

## 12. Final Checklist

- [ ] Understand the difference between a distributed lock and leader election.
- [ ] Created the leadership lease migration.
- [ ] Created `src/services/leader-election.service.ts`.
- [ ] Created `tests/leader-election.service.test.ts`.
- [ ] Verified the eight unit tests.
- [ ] Ran `npm run build`.
- [ ] Applied and verified the database migration.
- [ ] Understand how lease expiration permits takeover.
- [ ] Understand why renewal must verify both owner and fencing token.
- [ ] Understand why a stale leader must stop initiating new work.
- [ ] Understand that the service still needs a renewal runtime before production use.

## Success Criteria

Lecture 6 is complete when your tests pass, the build succeeds, and you can explain how PostgreSQL selects a leader, renews a lease, and prevents a stale owner from renewing a newer leadership term.

**Next: Module 3 — Lecture 7: Clock Drift, Timeouts, and Lease Safety.** We will explore how timing assumptions affect distributed coordination and why application clocks, network delays, and slow processes can invalidate naïve lock logic.
