
# Module 3 — Lecture 7: Clock Drift, Timeouts, and Lease Safety

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [Understanding Clock Drift](#2-understanding-clock-drift)
3. [Wall Clocks vs Monotonic Clocks](#3-wall-clocks-vs-monotonic-clocks)
4. [Understanding Lease Expiration](#4-understanding-lease-expiration)
5. [Timeouts and Ambiguous Outcomes](#5-timeouts-and-ambiguous-outcomes)
6. [Designing a Lease Timing Budget](#6-designing-a-lease-timing-budget)
7. [Implementing the Lease Timing Policy](#7-implementing-the-lease-timing-policy)
8. [Writing Unit Tests](#8-writing-unit-tests)
9. [Build and Test](#9-build-and-test)
10. [Break the Code Intentionally](#10-break-the-code-intentionally)
11. [Production Safety Considerations](#11-production-safety-considerations)
12. [Final Project Structure](#12-final-project-structure)
13. [Success Criteria](#13-success-criteria)

---

## 1. Learning Objectives

In Lecture 6, we studied leader election using a PostgreSQL-backed lease.

In this lecture, we investigate a critical distributed-systems problem:

**How can a process know that it still owns a lease when clocks, networks, and application execution are unreliable?**

By the end of this lecture, you will understand:

- Wall-clock time and monotonic time.
- Why `Date.now()` is not ideal for measuring elapsed durations.
- How lease expiration can create multiple apparent leaders.
- Why a request timeout does not prove that an operation failed.
- How renewal intervals, request timeouts, and safety margins interact.
- How to implement a pure lease-timing policy.
- How to test invalid timing configurations.
- Why timing validation alone cannot guarantee distributed-system safety.

### Our workflow

We will follow:

**Build → Test → Break intentionally → Understand failure → Fix → Verify**

### Important scope

This lecture adds a timing-policy module and its tests. It does not yet implement the full leader-renewal runtime or change the existing leader-election service.

---

## 2. Understanding Clock Drift

Imagine two application instances:

- Worker A acquires leadership.
- Worker B waits for the lease to expire.
- Worker A experiences a long pause.
- Its lease expires.
- Worker B acquires a new lease.
- Worker A resumes execution.

Worker A might still believe it is the leader.

If both workers perform leader-only operations, the system can experience duplicate processing or conflicting writes.

### Why can this happen?

Distributed systems operate under several timing uncertainties:

1. Machines may have slightly different wall-clock times.
2. Wall clocks can be adjusted.
3. Network requests can be delayed.
4. Databases can become temporarily unavailable.
5. Node.js event loops can pause under heavy load.
6. Garbage collection can delay application execution.
7. A process can be suspended and later resume.
8. A request can succeed on the server while its response is lost.

A lease helps coordinate ownership, but it does not automatically prevent an old process from continuing to execute code.

### Important distinction

**Lease expiration determines whether ownership remains valid. It does not physically stop the old process.**

That is why production systems often combine leases with fencing tokens and downstream validation.

---

## 3. Wall Clocks vs Monotonic Clocks

### 3.1 Wall-clock time

JavaScript provides wall-clock time through `Date.now()`.

**Example — standalone demonstration:**

```ts
const startedAt = Date.now();

// Perform some operation.

const elapsedMs = Date.now() - startedAt;

console.log({ elapsedMs });
```

`Date.now()` returns milliseconds since the Unix epoch.

It is useful for:

- Logging timestamps.
- Recording when an event occurred.
- Displaying dates.
- Storing application timestamps.

However, the system clock can be adjusted. If the clock moves backward, the calculated duration might be negative. If it moves forward, the calculated duration might be unexpectedly large.

Therefore, wall-clock subtraction is not the preferred method for measuring local elapsed time.

### 3.2 Monotonic time

Node.js provides `performance.now()` through `node:perf_hooks`.

**Example — standalone demonstration:**

```ts
import { performance } from "node:perf_hooks";

const startedAt = performance.now();

// Perform some operation.

const elapsedMs = performance.now() - startedAt;

console.log({ elapsedMs });
```

A monotonic clock is designed for measuring elapsed durations without following wall-clock adjustments.

Use it for:

- Measuring request duration.
- Measuring operation latency.
- Tracking elapsed processing time.
- Calculating local execution durations.

### 3.3 Which clock should we use?

| Requirement | Preferred approach |
|---|---|
| Log the current date and time | `Date.now()` or `new Date()` |
| Measure local elapsed duration | `performance.now()` |
| Determine database lease expiration | Database-authoritative time and conditional SQL |
| Prevent stale leaders from writing | Fencing tokens enforced by the protected resource |

**Remember:** A monotonic clock is local to a process. It is not a globally shared clock and cannot independently prove that a distributed lease remains valid.

---

## 4. Understanding Lease Expiration

Suppose Worker A acquires a lease for 15 seconds.

```text
Time       Worker A                     Worker B
-------------------------------------------------------
0 sec      Acquires lease               Waiting
5 sec      Attempts renewal             Waiting
10 sec     Continues work               Waiting
15 sec     Lease may expire             Can acquire lease
18 sec     Resumes after a pause         May be leader
```

The timeline illustrates the risk. The exact outcome depends on whether a renewal succeeds and on the database's lease state.

If Worker A pauses long enough, its local execution may resume after Worker B has acquired leadership.

### 4.1 Why renewal must happen before expiration

A renewal request needs time to:

1. Leave the application process.
2. Reach PostgreSQL.
3. Execute the renewal query.
4. Commit the transaction.
5. Return a response to the application.

A delayed response or a long event-loop pause can consume the remaining lease time.

### 4.2 Why a local boolean is insufficient

This code is not a safe ownership check:

```ts
let isLeader = true;

if (isLeader) {
  await performCriticalOperation();
}
```

The boolean describes the process's local belief. It does not prove that the lease is still valid in PostgreSQL.

A production leader runtime needs to transition out of its active-leader state conservatively when renewal cannot be confirmed.

Fencing tokens provide another layer of protection when the downstream resource rejects writes with stale tokens.

---

## 5. Timeouts and Ambiguous Outcomes

Consider this sequence:

1. Worker A sends a lease-renewal request.
2. PostgreSQL receives it.
3. PostgreSQL commits the renewal.
4. The response is lost because of a network problem.
5. Worker A times out.

Did the renewal succeed?

The client cannot determine the answer from the timeout alone.

The database operation may have succeeded even though the client did not receive its result.

### 5.1 What a timeout actually means

A timeout means the client stopped waiting within the configured period.

It does **not** necessarily mean:

- The server never received the request.
- The server did not execute the query.
- The transaction was rolled back.
- The database operation was cancelled.
- The lease definitely was not renewed.

### 5.2 Safe response to an ambiguous renewal

For a leader runtime, a conservative policy is:

1. Do not assume the lease is still valid.
2. Stop initiating leader-only operations.
3. Cancel or drain work where possible.
4. Re-establish ownership through the authoritative lease mechanism before resuming.
5. Ensure protected writes enforce fencing tokens where stale leaders must be rejected.

Aborting a local request does not necessarily cancel work already executing on the server.

---

## 6. Designing a Lease Timing Budget

For this exercise, we will use these example values:

| Setting | Example | Meaning |
|---|---:|---|
| Lease duration | 15,000 ms | Intended lease lifetime |
| Renewal interval | 5,000 ms | Planned time between renewal attempts |
| Request timeout | 2,000 ms | Maximum time the application waits for a renewal |
| Safety margin | 1,000 ms | Reserved time for uncertainty and cleanup |

These values are examples, not universal production defaults. Real values must be chosen based on observed database latency, network behavior, event-loop pauses, and the operation being protected.

### 6.1 Calculate the renewal budget

We define:

```text
Renewal budget = Request timeout + Safety margin
```

Therefore:

```text
Renewal budget = 2,000 + 1,000
               = 3,000 ms
```

The policy boundary is:

```text
Latest renewal-start boundary
    = Lease duration - Renewal budget

    = 15,000 - 3,000

    = 12,000 ms
```

Our planned renewal interval is 5,000 ms, which is below that boundary.

### 6.2 Important limitation

This is a configuration guardrail, not a mathematical proof of distributed safety.

A 12-second event-loop pause can still delay a renewal beyond the intended schedule. Network partitions and database failures can also defeat the timing assumptions.

The policy only rejects configurations that violate the specific rules we define.

---

## 7. Implementing the Lease Timing Policy

### 7.1 Create the policy file

**File:** `src/services/lease-timing.policy.ts`

**Action:** Create this new file. Do not replace `src/services/leader-election.service.ts`.

```ts
export interface LeaseTimingConfig {
  leaseDurationMs: number;
  renewalIntervalMs: number;
  requestTimeoutMs: number;
  safetyMarginMs: number;
}

export interface LeaseTimingBudget {
  leaseDurationMs: number;
  renewalIntervalMs: number;
  requestTimeoutMs: number;
  safetyMarginMs: number;
  renewalBudgetMs: number;
  latestSafeRenewalStartMs: number;
  isValid: true;
}

function assertPositiveInteger(
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive safe integer`
    );
  }
}

function assertNonNegativeInteger(
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative safe integer`
    );
  }
}

export function evaluateLeaseTiming(
  config: LeaseTimingConfig
): LeaseTimingBudget {
  const {
    leaseDurationMs,
    renewalIntervalMs,
    requestTimeoutMs,
    safetyMarginMs
  } = config;

  assertPositiveInteger(
    "leaseDurationMs",
    leaseDurationMs
  );

  assertPositiveInteger(
    "renewalIntervalMs",
    renewalIntervalMs
  );

  assertPositiveInteger(
    "requestTimeoutMs",
    requestTimeoutMs
  );

  assertNonNegativeInteger(
    "safetyMarginMs",
    safetyMarginMs
  );

  const renewalBudgetMs =
    requestTimeoutMs + safetyMarginMs;

  const latestSafeRenewalStartMs =
    leaseDurationMs - renewalBudgetMs;

  if (latestSafeRenewalStartMs <= 0) {
    throw new Error(
      "Request timeout and safety margin must be " +
      "smaller than the lease duration"
    );
  }

  if (
    renewalIntervalMs >=
    latestSafeRenewalStartMs
  ) {
    throw new Error(
      "Renewal interval leaves insufficient time " +
      "for the request timeout and safety margin"
    );
  }

  return {
    leaseDurationMs,
    renewalIntervalMs,
    requestTimeoutMs,
    safetyMarginMs,
    renewalBudgetMs,
    latestSafeRenewalStartMs,
    isValid: true
  };
}
```

### 7.2 Understand the implementation

The policy performs these checks:

1. Lease duration must be a positive safe integer.
2. Renewal interval must be a positive safe integer.
3. Request timeout must be a positive safe integer.
4. Safety margin must be a non-negative safe integer.
5. Request timeout plus safety margin must leave a positive renewal-start window.
6. The renewal interval must be strictly below the calculated boundary.

The policy does not connect to Redis or PostgreSQL and does not create timers. That makes it deterministic and easy to test.

**Production note:** If this module is later used with arbitrary external configuration, also validate computed arithmetic for safe-integer overflow.

---

## 8. Writing Unit Tests

### 8.1 Create the test file

**File:** `tests/lease-timing.policy.test.ts`

**Action:** Create this new test file.

```ts
import { describe, expect, it } from "vitest";

import {
  evaluateLeaseTiming,
  type LeaseTimingConfig
} from "../src/services/lease-timing.policy.js";

const validConfig: LeaseTimingConfig = {
  leaseDurationMs: 15_000,
  renewalIntervalMs: 5_000,
  requestTimeoutMs: 2_000,
  safetyMarginMs: 1_000
};

describe("evaluateLeaseTiming", () => {
  it("accepts a valid timing budget", () => {
    const result = evaluateLeaseTiming(validConfig);

    expect(result.isValid).toBe(true);
    expect(result.renewalBudgetMs).toBe(3_000);
    expect(result.latestSafeRenewalStartMs).toBe(
      12_000
    );
  });

  it("rejects a zero lease duration", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        leaseDurationMs: 0
      })
    ).toThrow(
      "leaseDurationMs must be a positive safe integer"
    );
  });

  it("rejects a negative renewal interval", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        renewalIntervalMs: -1
      })
    ).toThrow(
      "renewalIntervalMs must be a positive safe integer"
    );
  });

  it("rejects a non-integer request timeout", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        requestTimeoutMs: 1.5
      })
    ).toThrow(
      "requestTimeoutMs must be a positive safe integer"
    );
  });

  it("rejects a negative safety margin", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        safetyMarginMs: -1
      })
    ).toThrow(
      "safetyMarginMs must be a non-negative safe integer"
    );
  });

  it("rejects a timeout and margin that consume the lease", () => {
    expect(() =>
      evaluateLeaseTiming({
        leaseDurationMs: 3_000,
        renewalIntervalMs: 500,
        requestTimeoutMs: 2_000,
        safetyMarginMs: 1_000
      })
    ).toThrow(
      "Request timeout and safety margin must be " +
      "smaller than the lease duration"
    );
  });

  it("rejects a renewal interval that leaves insufficient time", () => {
    expect(() =>
      evaluateLeaseTiming({
        leaseDurationMs: 10_000,
        renewalIntervalMs: 7_000,
        requestTimeoutMs: 2_000,
        safetyMarginMs: 1_000
      })
    ).toThrow(
      "Renewal interval leaves insufficient time " +
      "for the request timeout and safety margin"
    );
  });

  it("accepts a zero safety margin but still checks the timeout", () => {
    const result = evaluateLeaseTiming({
      leaseDurationMs: 10_000,
      renewalIntervalMs: 5_000,
      requestTimeoutMs: 2_000,
      safetyMarginMs: 0
    });

    expect(result.renewalBudgetMs).toBe(2_000);
    expect(result.latestSafeRenewalStartMs).toBe(
      8_000
    );
  });
});
```

These tests use Vitest and do not need a running Redis or PostgreSQL server.

---

## 9. Build and Test

### 9.1 Open the project directory

**PowerShell:**

```powershell
cd D:\Production-Intelligence-Incident-Platform\production-intelligence-platform
```

### 9.2 Run only the new test

```powershell
npm run test:run -- tests/lease-timing.policy.test.ts
```

Expected result: all eight tests pass.

If your test script uses different arguments, inspect the existing `package.json` before changing scripts.

### 9.3 Build the TypeScript application

```powershell
npm run build
```

Expected result: TypeScript compilation succeeds.

### 9.4 Run the full test suite

```powershell
npm run test:run
```

Expected result: the new policy tests and existing tests pass.

Do not assume success without checking the actual command output.

---

## 10. Break the Code Intentionally

We will deliberately introduce invalid configurations to confirm that our guardrails work.

### Break A: Set the renewal interval too high

**File:** `tests/lease-timing.policy.test.ts`

Temporarily replace `validConfig` with:

```ts
const validConfig: LeaseTimingConfig = {
  leaseDurationMs: 15_000,
  renewalIntervalMs: 12_000,
  requestTimeoutMs: 2_000,
  safetyMarginMs: 1_000
};
```

Run:

```powershell
npm run test:run -- tests/lease-timing.policy.test.ts
```

#### Expected behavior

Tests that use this configuration should fail because the renewal interval equals the policy boundary.

Calculate:

```text
Lease duration:                 15,000 ms
Request timeout:                 2,000 ms
Safety margin:                   1,000 ms
Latest renewal-start boundary:  12,000 ms
Configured interval:            12,000 ms
```

The policy rejects equality because the interval must be strictly less than the boundary.

### Fix A

Restore:

```ts
renewalIntervalMs: 5_000,
```

Run the focused tests again.

### Break B: Make the timeout and margin consume the lease

Temporarily use:

```ts
const validConfig: LeaseTimingConfig = {
  leaseDurationMs: 3_000,
  renewalIntervalMs: 500,
  requestTimeoutMs: 2_000,
  safetyMarginMs: 1_000
};
```

Run the focused test suite.

The configuration should be rejected because:

```text
Request timeout + safety margin
= 2,000 + 1,000
= 3,000 ms
```

That consumes the entire 3,000 ms lease duration, leaving no positive renewal-start window.

### Fix B

Restore the original configuration:

```ts
const validConfig: LeaseTimingConfig = {
  leaseDurationMs: 15_000,
  renewalIntervalMs: 5_000,
  requestTimeoutMs: 2_000,
  safetyMarginMs: 1_000
};
```

Run all verification commands again:

```powershell
npm run test:run -- tests/lease-timing.policy.test.ts
npm run test:run
npm run build
```

---

## 11. Production Safety Considerations

Passing the timing-policy tests does not mean that the distributed system is safe under every failure.

| Failure | Why the timing policy cannot solve it alone |
|---|---|
| Node.js event-loop pause | A renewal timer may execute late. |
| Network partition | A renewal request or response may be lost. |
| Database outage | The leader cannot confirm lease validity. |
| Stale leader continues writing | The downstream resource must enforce fencing tokens. |
| Different machine clocks | A local timer cannot prove distributed ownership. |
| Request times out after commit | The operation may have succeeded despite the timeout. |

### Responsibilities of each mechanism

- **PostgreSQL lease:** Authoritative coordination of lease ownership and expiration.
- **Monotonic clock:** Local measurement of elapsed time.
- **Timing policy:** Rejects obviously invalid configuration.
- **Renewal runtime:** Attempts renewal and reacts to failures.
- **Fencing tokens:** Allow protected resources to reject stale owners.
- **Graceful shutdown:** Stops resources and leader-only activity in a controlled manner.
- **Observability:** Exposes renewal latency, failures, and leadership transitions.

The next lecture will connect these concepts into a controlled leader runtime. We have deliberately not modified the existing leader-election service or worker lifecycle in this lecture.

---

## 12. Final Project Structure

Only two new files are required for this lecture.

```text
production-intelligence-platform/
├── src/
│   └── services/
│       ├── leader-election.service.ts
│       └── lease-timing.policy.ts        # NEW
└── tests/
    ├── leader-election.service.test.ts
    └── lease-timing.policy.test.ts       # NEW
```

Do not create a database migration for this lecture. Do not replace existing migrations or unrelated service files.

---

## 13. Success Criteria

- [ ] Created `src/services/lease-timing.policy.ts`.
- [ ] Created `tests/lease-timing.policy.test.ts`.
- [ ] All eight focused tests pass.
- [ ] The complete test suite passes.
- [ ] `npm run build` succeeds.
- [ ] Can explain wall-clock time versus monotonic time.
- [ ] Can explain why a timeout does not prove that an operation failed.
- [ ] Can explain why a local `isLeader` flag is not authoritative.
- [ ] Understand that timing validation is a guardrail, not a proof of distributed safety.

---

## Next Lecture

**Module 3 — Lecture 8: Building a Safe Leader Runtime**

We will connect the lease service to a controlled renewal lifecycle, leader-state transitions, failure handling, and graceful shutdown. We will also account for fencing and ensure that a successful local timer is never treated as proof of distributed ownership.
