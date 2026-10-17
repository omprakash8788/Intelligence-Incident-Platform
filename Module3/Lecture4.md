
# Module 3 — Lecture 4: The Redlock Algorithm

## Table of Contents

1. Learning objectives
2. Why a single Redis instance creates a limitation
3. What Redlock is
4. How quorum-based locking works
5. Calculate the lock validity window
6. Implement the quorum policy in TypeScript
7. Write unit tests
8. Build and verify
9. Break it intentionally
10. Redlock limitations and production trade-offs
11. Final checklist

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a lock stored on one Redis instance depends on that instance's availability and failover behavior.
- How Redlock uses multiple independent Redis instances.
- What a quorum means and why a majority is required.
- How to calculate whether a lock has enough validity time remaining.
- Why clock drift, network delays, and process pauses matter.
- Why Redlock is not a universal solution to distributed consistency.

### Prerequisites

Confirm that Lecture 2's lock service and tests are working, and that Lecture 3's worker integration builds if you have implemented it.

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

We will not modify your Docker Compose file or create additional Redis servers in this lecture. First, we will implement and test the algorithm's decision rules independently.

---

## 2. Why a Single Redis Instance Creates a Limitation

Your current lock acquisition uses one Redis instance:

```redis
SET lock:account:1001 test-token NX PX 60000
```

You verified that the first owner receives `OK` and a competing owner receives `(nil)`.

That is correct behavior for a single Redis instance.

However, consider a failure scenario:

1. Process A acquires a lock on Redis primary A.
2. Redis A fails before its lock state is safely replicated.
3. A replica is promoted to become the new primary.
4. The promoted replica does not contain the lock.
5. Process B acquires the same logical lock on the new primary.

Now both processes may believe they own the resource.

Whether this exact failure can occur depends on your Redis topology, replication behavior, and failure timing. The important lesson is that **a single-instance lock and a highly available distributed lock have different assumptions**.

Adding a Redis replica does not automatically make the single-instance lock safe under every failover scenario.

---

## 3. What Is Redlock?

Redlock is an algorithm for acquiring a distributed lock across multiple independent Redis instances.

A typical conceptual deployment uses five independent Redis nodes.

```text
             Lock request
                  |
        +---------+---------+
        |         |         |
        v         v         v
     Redis 1   Redis 2   Redis 3
        |         |         |
        +---------+---------+
                  |
             Redis 4, 5
```

The client tries to acquire the same logical lock on all five nodes, using the same unique ownership token.

A lock is considered acquired when:

- The client acquires the lock on a majority of the independent nodes.
- The acquisition completes within the required timing limits.
- The calculated validity window remains positive after accounting for elapsed time and clock drift assumptions.

For five nodes, the required majority is three.

| Independent nodes | Required majority |
|---:|---:|
| 1 | 1 |
| 3 | 2 |
| 5 | 3 |
| 7 | 4 |

The nodes must be independent enough for the intended failure model. Five connections to one Redis server are still one server, not five independent nodes.

### Important distinction

This lecture implements and tests the **quorum and validity calculations**. It does not build a complete Redlock client or claim that your current single-Redis Docker deployment is running Redlock.

---

## 4. How Quorum-Based Locking Works

Suppose a client uses five independent Redis instances and requests a lock with a 10-second TTL.

The client records the start time and attempts to acquire the lock on the instances.

Example:

| Redis instance | Result |
|---|---|
| Redis 1 | Acquired |
| Redis 2 | Acquired |
| Redis 3 | Acquired |
| Redis 4 | Unavailable |
| Redis 5 | Timed out |

Three of five instances granted the lock, so the client reached a majority.

However, reaching a majority alone is insufficient.

If acquiring the lock took too long, too little validity time may remain. The client must calculate whether the lock is still valid according to the algorithm's timing assumptions.

### What if only two instances grant the lock?

The client must not report successful acquisition because two is not a majority of five.

It should attempt to release any partial locks it acquired before reporting failure, using the ownership token to avoid deleting another owner's lock.

### What if the client cannot reach enough instances?

The operation should fail closed: it must not claim that it acquired the lock.

This may reduce availability during failures, but proceeding as if the lock had been acquired would undermine the coordination guarantee.

---

## 5. Calculate the Lock Validity Window

The requested TTL is not the same as the usable validity window.

A simplified validity calculation is:

\[
\text{validity} =
\text{TTL} - \text{elapsed time} - \text{drift allowance}
\]

For example, suppose:

- Requested TTL = 10,000 ms
- Time spent acquiring locks = 200 ms
- Drift factor = 0.01
- Additional drift allowance = 2 ms

Then:

\[
\text{drift allowance}
= 10{,}000 \times 0.01 + 2
= 102\text{ ms}
\]

And:

\[
\text{validity}
= 10{,}000 - 200 - 102
= 9{,}698\text{ ms}
\]

The example uses a simplified version of the timing calculation. A complete implementation must also follow the chosen library's timing, retry, release, and clock assumptions.

If the calculated validity is zero or negative, the client must not treat the lock as successfully acquired.

---

## 6. Implement the Quorum Policy in TypeScript

We will create a small, pure policy module. It will not connect to Redis, so we can test the decision rules without changing your current infrastructure.

### 6.1 Create the policy

**File:** `src/services/redlock-quorum.policy.ts`

**Action:** Create this file.

```ts
export interface RedlockQuorumInput {
  nodeCount: number;
  acquiredCount: number;
  ttlMs: number;
  elapsedMs: number;
  driftFactor: number;
}

export interface RedlockQuorumResult {
  quorum: number;
  hasQuorum: boolean;
  driftAllowanceMs: number;
  validityMs: number;
  canUseLock: boolean;
}

export function evaluateRedlockQuorum(
  input: RedlockQuorumInput
): RedlockQuorumResult {
  const {
    nodeCount,
    acquiredCount,
    ttlMs,
    elapsedMs,
    driftFactor
  } = input;

  if (
    !Number.isSafeInteger(nodeCount) ||
    nodeCount < 1
  ) {
    throw new Error(
      "nodeCount must be a positive integer"
    );
  }

  if (
    !Number.isSafeInteger(acquiredCount) ||
    acquiredCount < 0 ||
    acquiredCount > nodeCount
  ) {
    throw new Error(
      "acquiredCount must be between zero and nodeCount"
    );
  }

  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new Error(
      "ttlMs must be a positive integer"
    );
  }

  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  ) {
    throw new Error(
      "elapsedMs must be a non-negative number"
    );
  }

  if (
    !Number.isFinite(driftFactor) ||
    driftFactor < 0 ||
    driftFactor >= 1
  ) {
    throw new Error(
      "driftFactor must be in the range [0, 1)"
    );
  }

  const quorum = Math.floor(nodeCount / 2) + 1;

  const hasQuorum = acquiredCount >= quorum;

  const driftAllowanceMs =
    ttlMs * driftFactor + 2;

  const validityMs =
    ttlMs - elapsedMs - driftAllowanceMs;

  return {
    quorum,
    hasQuorum,
    driftAllowanceMs,
    validityMs,
    canUseLock: hasQuorum && validityMs > 0
  };
}
```

### 6.2 Understand the policy

For five nodes:

```ts
const quorum = Math.floor(5 / 2) + 1;
```

The result is `3`.

For the validity window:

```ts
const validityMs =
  ttlMs - elapsedMs - driftAllowanceMs;
```

The lock is usable only when both conditions hold:

```ts
const canUseLock = hasQuorum && validityMs > 0;
```

This module only evaluates inputs. It does not acquire or release Redis locks, validate that nodes are independent, measure actual elapsed time, or guarantee distributed mutual exclusion.

Those responsibilities belong to a complete Redlock implementation.

---

## 7. Write Unit Tests

### 7.1 Create the test file

**File:** `tests/redlock-quorum.policy.test.ts`

**Action:** Create this file.

```ts
import {
  describe,
  expect,
  it
} from "vitest";

import {
  evaluateRedlockQuorum
} from "../src/services/redlock-quorum.policy.js";

describe("evaluateRedlockQuorum", () => {
  it("requires three nodes out of five", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 3,
      ttlMs: 10_000,
      elapsedMs: 200,
      driftFactor: 0.01
    });

    expect(result.quorum).toBe(3);
    expect(result.hasQuorum).toBe(true);
    expect(result.canUseLock).toBe(true);
  });

  it("rejects a minority of acquired locks", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 2,
      ttlMs: 10_000,
      elapsedMs: 200,
      driftFactor: 0.01
    });

    expect(result.quorum).toBe(3);
    expect(result.hasQuorum).toBe(false);
    expect(result.canUseLock).toBe(false);
  });

  it("rejects a lock with no remaining validity", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 5,
      ttlMs: 1_000,
      elapsedMs: 1_100,
      driftFactor: 0.01
    });

    expect(result.hasQuorum).toBe(true);
    expect(result.validityMs).toBeLessThanOrEqual(0);
    expect(result.canUseLock).toBe(false);
  });

  it("calculates the validity window", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 3,
      ttlMs: 10_000,
      elapsedMs: 200,
      driftFactor: 0.01
    });

    expect(result.driftAllowanceMs).toBe(102);
    expect(result.validityMs).toBe(9_698);
  });

  it("rejects invalid node counts", () => {
    expect(() =>
      evaluateRedlockQuorum({
        nodeCount: 0,
        acquiredCount: 0,
        ttlMs: 10_000,
        elapsedMs: 0,
        driftFactor: 0.01
      })
    ).toThrow("nodeCount must be a positive integer");
  });

  it("rejects more acquired nodes than available nodes", () => {
    expect(() =>
      evaluateRedlockQuorum({
        nodeCount: 3,
        acquiredCount: 4,
        ttlMs: 10_000,
        elapsedMs: 0,
        driftFactor: 0.01
      })
    ).toThrow(
      "acquiredCount must be between zero and nodeCount"
    );
  });

  it("rejects an invalid drift factor", () => {
    expect(() =>
      evaluateRedlockQuorum({
        nodeCount: 5,
        acquiredCount: 3,
        ttlMs: 10_000,
        elapsedMs: 0,
        driftFactor: 1
      })
    ).toThrow(
      "driftFactor must be in the range [0, 1)"
    );
  });
});
```

These tests cover the decision rules, not a real multi-instance Redis deployment.

---

## 8. Build and Verify

Run these commands from your project root.

### Step 1: Run the new tests

**PowerShell:**

```powershell
npm run test:run -- tests/redlock-quorum.policy.test.ts
```

Expected: all seven tests pass.

### Step 2: Build TypeScript

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

### Step 3: Run all tests

```powershell
npm run test:run
```

Expected: the new policy tests and your existing tests pass.

If any existing test fails, investigate the failure rather than assuming it is unrelated.

---

## 9. Break It Intentionally

### Experiment A: Reduce the acquired count

Use this input in a temporary test:

```ts
evaluateRedlockQuorum({
  nodeCount: 5,
  acquiredCount: 2,
  ttlMs: 10_000,
  elapsedMs: 200,
  driftFactor: 0.01
});
```

Expected result:

- `quorum` is `3`.
- `hasQuorum` is `false`.
- `canUseLock` is `false`.

**Root cause:** Two successful acquisitions do not constitute a majority of five.

**Fix:** Do not proceed with the protected operation unless the complete acquisition algorithm reports success.

### Experiment B: Increase the elapsed time

Use this input:

```ts
evaluateRedlockQuorum({
  nodeCount: 5,
  acquiredCount: 5,
  ttlMs: 1_000,
  elapsedMs: 1_100,
  driftFactor: 0.01
});
```

Expected result:

- `hasQuorum` is `true`.
- `validityMs` is negative.
- `canUseLock` is `false`.

**Root cause:** The acquisition took longer than the requested TTL.

**Fix:** Reject the acquisition. A majority of successful replies does not mean that enough validity time remains.

### Experiment C: Use an invalid node count

Change `nodeCount` to `0`.

Expected: the policy throws an error before calculating a quorum.

**Root cause:** A deployment with zero nodes cannot provide a quorum.

**Fix:** Validate inputs and ensure the actual lock client is configured with the intended independent nodes.

---

## 10. Redlock Limitations and Production Trade-Offs

### A. Quorum is not a guarantee against every failure

Redlock depends on its deployment assumptions, timing model, and implementation details. Network delays, pauses, clock behavior, and failover scenarios must be considered carefully.

There is ongoing technical debate about the guarantees of lease-based distributed locks under asynchronous network and process failures. Do not treat Redlock as a universal answer to distributed consistency.

### B. A lock can expire while the holder is still working

Suppose a worker acquires a 10-second lease and pauses for 15 seconds.

The lease may expire. Another worker may acquire the lock and start work while the first worker is still running.

A lease coordinates ownership only for its validity period. It cannot force an old process to stop executing.

### C. Fencing tokens can protect downstream writes

A fencing token is a monotonically increasing number assigned to each new lock owner. The downstream resource rejects operations from older owners after a newer token has been accepted.

This can prevent a stale worker from overwriting newer state, provided the downstream system enforces the token correctly.

We will study fencing tokens in Module 3, Lecture 5.

### D. Idempotency still matters

Even if a lock prevents concurrent execution during the lease, a worker may crash after committing a database transaction and before acknowledging the BullMQ job.

BullMQ may deliver the job again.

For operations that must not create duplicate business effects, retain the idempotency protections from Lecture 1.

### E. PostgreSQL may be the better choice

For an operation that changes a database row, consider PostgreSQL transactions, row-level locking, unique constraints, and conditional updates first.

A Redis lock should not replace the database's own consistency mechanisms when the database is the system of record.

### F. Use a maintained implementation for a real Redlock deployment

The policy module in this lecture is educational. Do not use it as a complete lock implementation.

Before deploying Redlock, evaluate a maintained implementation, its documented failure model, timeout behavior, lock extension, release semantics, monitoring, and compatibility with your Redis topology.

Do not point a Redlock client at multiple connections to the same Redis server and assume you have gained independent-node fault tolerance.

---

## 11. Final Checklist

- [ ] Understand why a single Redis instance has different failure assumptions from a multi-instance lock.
- [ ] Understand the Redlock quorum.
- [ ] Understand why five independent nodes require three successful acquisitions.
- [ ] Understand the validity-window calculation.
- [ ] Created `src/services/redlock-quorum.policy.ts`.
- [ ] Created `tests/redlock-quorum.policy.test.ts`.
- [ ] Ran the seven tests.
- [ ] Built the application successfully.
- [ ] Tested insufficient quorum and expired validity.
- [ ] Understand that the policy tests do not implement or verify a full Redlock deployment.
- [ ] Understand why idempotency and database constraints remain necessary.

## Success Criteria

Lecture 4 is complete when the policy tests pass, your TypeScript build succeeds, and you can explain why Redlock requires both a majority and a positive validity window.

**Next: Module 3 — Lecture 5: Lock Expiration, Leases, and Fencing Tokens.** We will examine the stale-worker problem and build a stronger way to protect shared state when an old lock holder continues running after its lease expires.
