# Module 3 — Lecture 18: Failure Recovery and Crash-Window Analysis

## Table of Contents

1. [Learning objectives](#1-learning-objectives)
2. [Why crash-window analysis matters](#2-why-crash-window-analysis-matters)
3. [The end-to-end failure timeline](#3-the-end-to-end-failure-timeline)
4. [Delivery guarantees and recovery rules](#4-delivery-guarantees-and-recovery-rules)
5. [Project scope and file changes](#5-project-scope-and-file-changes)
6. [Implement the crash-window recovery policy](#6-implement-the-crash-window-recovery-policy)
7. [Write unit tests](#7-write-unit-tests)
8. [Build and test](#8-build-and-test)
9. [Intentional break, root cause, fix, and retest](#9-intentional-break-root-cause-fix-and-retest)
10. [Failure scenarios to reason through](#10-failure-scenarios-to-reason-through)
11. [Final folder structure](#11-final-folder-structure)
12. [Success criteria](#12-success-criteria)
13. [Key takeaways](#13-key-takeaways)

---

## 1. Learning objectives

By the end of this lecture, you should be able to:

- Identify the exact point where a distributed operation can fail.
- Distinguish a rolled-back database transaction from a committed transaction.
- Explain why a publisher can deliver the same event more than once.
- Decide whether a failed operation should be retried, recovered, or reconciled.
- Understand why a timeout does not necessarily mean an operation failed.
- Write deterministic unit tests for crash-recovery decisions.
- Explain why the transactional outbox pattern normally provides **at-least-once delivery**, not automatic exactly-once business effects.

### What we are building

We will create a small, pure TypeScript policy that classifies a crash window and returns the appropriate recovery decision.

It will not connect to PostgreSQL or Redis. It will not publish messages. It will not change your worker lifecycle.

That separation is intentional: first make the recovery rules testable, then integrate them into real infrastructure in a later lecture.

## 2. Why crash-window analysis matters

Imagine an application performing this operation:

1. Update an order in PostgreSQL.
2. Insert an event into an outbox table in the same transaction.
3. A publisher reads the event.
4. The publisher sends the event to a destination.
5. The publisher marks the event as published.

The operation crosses several boundaries. A process can crash between any two steps.

For example:

```text
PostgreSQL transaction commits
            |
            v
Publisher sends event
            |
            v
Destination accepts event
            |
            X  Publisher crashes here
            |
            v
Outbox row marked as published
```

The destination has received the event, but the outbox row still appears unpublished.

When the publisher restarts, it may send the event again.

This is not necessarily a bug in PostgreSQL, Redis, or BullMQ. It is a consequence of the publisher being unable to atomically commit its local database update and an independent destination's side effect.

**Important principle:** recovery logic must account for what might already have happened, not just what the current process remembers.

## 3. The end-to-end failure timeline

Consider the following timeline.

```text
T0  Begin database transaction
 |
T1  Update business data
 |
T2  Insert outbox event
 |
T3  Commit database transaction
 |
T4  Claim outbox event
 |
T5  Send event to destination
 |
T6  Destination accepts event
 |
T7  Mark outbox event as published
```

The same process can fail at each boundary, but the correct recovery action differs.

### Crash-window matrix

| Crash point | What we know | Correct recovery direction |
|---|---|---|
| Before transaction commit | The transaction may not have committed | Retry the complete transaction after resolving the outcome |
| After commit, before claim | The business change and outbox event are durable | Claim the pending event |
| After claim, before delivery | The event may remain leased to a dead publisher | Allow lease expiry and reclaim it |
| During delivery or after a timeout | The destination may or may not have accepted the event | Retry safely, using destination-side idempotency where possible |
| After destination acceptance, before marking published | The destination may already have processed the event | Redelivery may happen; deduplicate the business effect |
| After marking published | The publisher recorded successful delivery | Do not normally republish the event |

There is an important nuance in the first row: if the application loses its database connection while committing, it may not know whether the transaction committed. A client-side error alone is not proof of rollback.

The safe next step may be to query durable state or retry through an idempotent operation—not blindly repeat an unprotected business effect.

## 4. Delivery guarantees and recovery rules

### 4.1 At-most-once delivery

An event is attempted at most once. A crash can cause the event to be lost.

This can be acceptable for certain best-effort notifications, but it is generally unsuitable when every event must eventually be processed.

### 4.2 At-least-once delivery

An event is retried until successful delivery is recorded, subject to the system's retry and operational policies.

This improves delivery reliability, but duplicate delivery is possible.

### 4.3 Exactly-once business effects

Exactly-once delivery across independent systems is not something a publisher can guarantee merely by retrying or updating a database flag.

A practical design usually combines:

- Durable event storage.
- At-least-once delivery.
- A stable event identifier.
- Destination-side idempotency or deduplication.
- Transactional updates where the destination supports them.
- Reconciliation for uncertain outcomes.

For example, the destination can record an `event_id` under a unique constraint in the same transaction as its business change. If the same event arrives again, the destination recognizes it and avoids repeating the effect.

This only works when the deduplication record and the business effect are coordinated atomically. Merely checking an ID in one transaction and applying the effect in another creates another crash window.

### 4.4 Recovery is not the same as retry

A retry repeats an operation. Recovery determines what is safe to do given the durable state and the possibility that a previous attempt already succeeded.

For example:

- An uncommitted transaction can often be retried as a whole.
- A committed outbox event should be delivered, not recreated as a new logical event.
- An expired claim can be reclaimed.
- A delivery timeout requires caution because the destination may have accepted the event.
- An already published event should not ordinarily be published again just because a worker restarted.

We will encode these distinctions as a policy.

## 5. Project scope and file changes

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Create these two files:

- `src/services/crash-window.policy.ts`
- `tests/crash-window.policy.test.ts`

### What this lecture changes

- Adds a pure recovery-policy module.
- Adds deterministic unit tests.
- Does not add a database migration.
- Does not modify existing services.
- Does not modify `src/workers.ts`.
- Does not require Redis or PostgreSQL to be running for these unit tests.

**Do not wire this policy into the outbox publisher yet.** This lecture establishes the decisions and tests independently. We should integrate it only after confirming the real publisher's current behavior and the existing tests.

## 6. Implement the crash-window recovery policy

### File: `src/services/crash-window.policy.ts`

**Action:** Create this new file.

```typescript
export type CrashWindow =
  | "before-transaction-commit"
  | "after-transaction-commit"
  | "after-claim-before-delivery"
  | "delivery-outcome-unknown"
  | "after-delivery-before-published-mark"
  | "after-published-mark";

export type RecoveryAction =
  | "resolve-transaction-outcome"
  | "claim-pending-event"
  | "wait-for-lease-expiry-or-reclaim"
  | "retry-with-deduplication"
  | "reconcile-durable-state"
  | "no-republish-required";

export interface CrashRecoveryPlan {
  action: RecoveryAction;
  duplicateDeliveryPossible: boolean;
  businessEffectMayAlreadyHaveOccurred: boolean;
  explanation: string;
}

const RECOVERY_PLANS: Record<CrashWindow, CrashRecoveryPlan> = {
  "before-transaction-commit": {
    action: "resolve-transaction-outcome",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: false,
    explanation:
      "Resolve whether the database transaction committed before retrying the logical operation."
  },

  "after-transaction-commit": {
    action: "claim-pending-event",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: false,
    explanation:
      "The committed outbox event is durable and can be claimed for publication."
  },

  "after-claim-before-delivery": {
    action: "wait-for-lease-expiry-or-reclaim",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: false,
    explanation:
      "The claim may belong to a crashed publisher; reclaim the event according to the lease policy."
  },

  "delivery-outcome-unknown": {
    action: "retry-with-deduplication",
    duplicateDeliveryPossible: true,
    businessEffectMayAlreadyHaveOccurred: true,
    explanation:
      "The destination may have accepted the event even though the publisher did not receive confirmation."
  },

  "after-delivery-before-published-mark": {
    action: "retry-with-deduplication",
    duplicateDeliveryPossible: true,
    businessEffectMayAlreadyHaveOccurred: true,
    explanation:
      "The destination may have processed the event before the publisher crashed."
  },

  "after-published-mark": {
    action: "no-republish-required",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: true,
    explanation:
      "The publisher recorded successful delivery; ordinary recovery should not republish this event."
  }
};

export function getCrashRecoveryPlan(
  window: CrashWindow
): CrashRecoveryPlan {
  return { ...RECOVERY_PLANS[window] };
}
```

### Understand the design

**Why use a union type?**

`CrashWindow` restricts callers to the six scenarios we have explicitly modeled. A misspelled value such as `"after-delivery"` will fail TypeScript type-checking when passed as a literal.

**Why use `Record<CrashWindow, CrashRecoveryPlan>`?**

The mapping requires a plan for every defined crash window. If you add a new member to the union without adding its plan, TypeScript reports the missing entry.

**Why return a copy?**

The function returns a shallow copy so a caller cannot directly replace a plan's properties and mutate the stored policy through the returned object.

**Why is this a policy rather than a publisher?**

The function does not claim that a transaction committed, that a lease expired, or that a destination processed an event. It only describes the recovery approach associated with a known or suspected failure window.

In a real publisher, the window must be determined from durable state, error handling, and destination guarantees—not guessed from a log message alone.

## 7. Write unit tests

### File: `tests/crash-window.policy.test.ts`

**Action:** Create this new file.

```typescript
import { describe, expect, it } from "vitest";

import {
  getCrashRecoveryPlan,
  type CrashWindow
} from "../src/services/crash-window.policy.js";

describe("getCrashRecoveryPlan", () => {
  it("resolves transaction outcome before retrying", () => {
    const plan = getCrashRecoveryPlan(
      "before-transaction-commit"
    );

    expect(plan.action).toBe(
      "resolve-transaction-outcome"
    );

    expect(plan.duplicateDeliveryPossible).toBe(false);
  });

  it("claims an event after the transaction commits", () => {
    const plan = getCrashRecoveryPlan(
      "after-transaction-commit"
    );

    expect(plan.action).toBe("claim-pending-event");
    expect(plan.businessEffectMayAlreadyHaveOccurred).toBe(
      false
    );
  });

  it("reclaims a claim after the publisher crashes", () => {
    const plan = getCrashRecoveryPlan(
      "after-claim-before-delivery"
    );

    expect(plan.action).toBe(
      "wait-for-lease-expiry-or-reclaim"
    );

    expect(plan.duplicateDeliveryPossible).toBe(false);
  });

  it("treats an unknown delivery outcome as potentially successful", () => {
    const plan = getCrashRecoveryPlan(
      "delivery-outcome-unknown"
    );

    expect(plan.action).toBe("retry-with-deduplication");
    expect(plan.duplicateDeliveryPossible).toBe(true);
    expect(plan.businessEffectMayAlreadyHaveOccurred).toBe(
      true
    );
  });

  it("accounts for a crash after delivery but before acknowledgement", () => {
    const plan = getCrashRecoveryPlan(
      "after-delivery-before-published-mark"
    );

    expect(plan.action).toBe("retry-with-deduplication");
    expect(plan.duplicateDeliveryPossible).toBe(true);
    expect(plan.explanation).toContain(
      "before the publisher crashed"
    );
  });

  it("does not normally republish an event already marked published", () => {
    const plan = getCrashRecoveryPlan("after-published-mark");

    expect(plan.action).toBe("no-republish-required");
    expect(plan.businessEffectMayAlreadyHaveOccurred).toBe(
      true
    );
  });

  it("provides a recovery plan for every crash window", () => {
    const windows: CrashWindow[] = [
      "before-transaction-commit",
      "after-transaction-commit",
      "after-claim-before-delivery",
      "delivery-outcome-unknown",
      "after-delivery-before-published-mark",
      "after-published-mark"
    ];

    for (const window of windows) {
      const plan = getCrashRecoveryPlan(window);

      expect(plan.action.length).toBeGreaterThan(0);
      expect(plan.explanation.length).toBeGreaterThan(0);
    }
  });

  it("does not expose the stored plan for direct mutation", () => {
    const first = getCrashRecoveryPlan(
      "delivery-outcome-unknown"
    );

    first.action = "no-republish-required";

    const second = getCrashRecoveryPlan(
      "delivery-outcome-unknown"
    );

    expect(second.action).toBe("retry-with-deduplication");
  });
});
```

### Why the tests matter

These tests verify that:

1. Each crash window has a defined recovery decision.
2. Unknown delivery outcomes are treated conservatively.
3. The policy identifies where duplicates are possible.
4. A returned plan cannot mutate the stored mapping.

They do **not** prove that your real outbox publisher recovers correctly. That requires integration tests against the actual database, claim/lease logic, and destination behavior.

## 8. Build and test

Run the commands from your project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

### Step 1 — Run only this lecture's tests

```powershell
npm run test:run -- tests/crash-window.policy.test.ts
```

Expected result: all eight tests pass.

If your Vitest script uses a different name in `package.json`, use the existing test script rather than adding a duplicate script.

### Step 2 — Build the project

```powershell
npm run build
```

Expected result: TypeScript compilation completes without errors.

A successful build only verifies compilation. It does not prove that the recovery policy is integrated with the database or publisher.

### Step 3 — Run the full unit-test suite

```powershell
npm run test:run
```

Expected result: the existing unit tests and this lecture's tests pass.

If unrelated existing tests fail, record the exact failing test and error. Do not assume this lecture caused the failure without investigating it.

## 9. Intentional break, root cause, fix, and retest

We will deliberately introduce a policy regression, observe the test failure, and restore the correct behavior.

### Step 1 — Break the policy

**File:** `src/services/crash-window.policy.ts`

Find the `"after-delivery-before-published-mark"` entry in `RECOVERY_PLANS`.

Temporarily replace this line:

```typescript
action: "retry-with-deduplication",
```

with:

```typescript
action: "no-republish-required",
```

Only change that one entry. Do not change the `"delivery-outcome-unknown"` entry.

### Step 2 — Run the targeted test

```powershell
npm run test:run -- tests/crash-window.policy.test.ts
```

Expected result: the test named:

`accounts for a crash after delivery but before acknowledgement`

should fail because it expects `"retry-with-deduplication"`.

### Step 3 — Understand the root cause

The publisher may have successfully delivered the event, but it crashed before recording that success in its own database.

The database therefore does not necessarily contain evidence that the destination processed the event.

Returning `"no-republish-required"` assumes the delivery is safely complete. That assumption is not justified by the available evidence.

The recovery policy should instead permit redelivery while requiring the destination to handle duplicates safely.

### Step 4 — Fix the policy

**File:** `src/services/crash-window.policy.ts`

Restore the `"after-delivery-before-published-mark"` entry to:

```typescript
"after-delivery-before-published-mark": {
  action: "retry-with-deduplication",
  duplicateDeliveryPossible: true,
  businessEffectMayAlreadyHaveOccurred: true,
  explanation:
    "The destination may have processed the event before the publisher crashed."
},
```

### Step 5 — Retest

```powershell
npm run test:run -- tests/crash-window.policy.test.ts
```

Then run:

```powershell
npm run build
```

The targeted test should pass again, and the build should succeed if there are no unrelated compilation errors.

**Important:** the break-and-fix exercise demonstrates the policy decision. It does not simulate a real process crash or prove destination-side deduplication works.

## 10. Failure scenarios to reason through

Use these scenarios to check your understanding.

### Scenario A — The transaction commits, then the API crashes

The application updates an order and inserts an outbox event in one transaction. PostgreSQL commits. The API process crashes before returning a response to the client.

**Question:** Should the client assume the operation failed and submit a new order?

**Answer:** No. The client received no reliable confirmation, but the transaction may have committed. The API needs an idempotency mechanism or a durable way to retrieve the original result. Creating a new logical order blindly can produce duplicate orders.

### Scenario B — The publisher crashes after claiming an event

The publisher claims an outbox event with a lease. It crashes before contacting the destination.

**Question:** Should another publisher be allowed to claim the event immediately?

**Answer:** It should follow the lease and reclaim policy. If the original lease is still valid, another publisher generally should not steal it. After expiry, the event can be reclaimed, assuming the claim mechanism correctly handles concurrent publishers.

### Scenario C — The destination processes the event, but the response is lost

The destination performs its business update and commits. The network connection drops before the publisher receives the response.

**Question:** Can the publisher safely assume the event was not processed?

**Answer:** No. The outcome is unknown. A retry may be necessary, but the destination must recognize the same logical event and avoid applying the business effect twice.

### Scenario D — The publisher marks the event published

The destination confirms success, and the publisher records `published_at` in PostgreSQL.

**Question:** Does that alone prove the destination performed the effect exactly once?

**Answer:** No. It proves the publisher recorded the delivery as complete. Exactly-once business effects require appropriate guarantees at the destination, such as atomic deduplication with the business update.

### Scenario E — The lease expires during a slow delivery

Publisher A starts sending an event, but the destination responds slowly. A's lease expires, and publisher B reclaims the event.

**Question:** Could both publishers deliver it?

**Answer:** Yes. A lease coordinates ownership of the claim, but it cannot always cancel an external request that is already in progress. Lease renewal, timeouts, and fencing can reduce some risks; destination-side idempotency is still needed for duplicate effects.

## 11. Final folder structure

After creating the two lecture files, the relevant structure should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   └── migrations/
│   ├── services/
│   │   └── crash-window.policy.ts
│   ├── workers.ts
│   └── server.ts
└── tests/
    └── crash-window.policy.test.ts
```

This is a **partial view** of the project structure, not a replacement for your existing files. Keep all existing files and migrations in place.

No migration is required for this lecture. No edits to `src/workers.ts` are required.

## 12. Success criteria

- [ ] Created `src/services/crash-window.policy.ts`.
- [ ] Created `tests/crash-window.policy.test.ts`.
- [ ] Tested all six crash windows.
- [ ] Verified that an unknown delivery outcome is treated as potentially successful.
- [ ] Performed the intentional break.
- [ ] Observed the expected failing test.
- [ ] Restored the correct policy and reran the tests.
- [ ] Ran the project build.
- [ ] Left `src/workers.ts` unchanged.
- [ ] Added no database migration.

Do not mark a step complete until you have actually performed it.

## 13. Key takeaways

1. **A timeout is not proof of failure.** The destination may already have committed its work.
2. **A database commit and an external delivery are separate operations.** A crash can occur between them.
3. **At-least-once delivery permits duplicates.** Consumers need idempotent processing when duplicate effects are unacceptable.
4. **A lease is not a universal duplicate-prevention mechanism.** It coordinates ownership but cannot undo an already-issued external request.
5. **Recovery decisions must be based on evidence.** Distinguish known failure, known success, and unknown outcome.
6. **A policy unit test is not an integration test.** Real crash-window behavior must eventually be tested with durable state and controlled failure injection.

### Next lecture

**Module 3 — Lecture 19: Distributed Systems Integration Testing**

We will focus on testing real interactions and failure recovery across PostgreSQL, leases, and coordinated workers—not just testing isolated policies.