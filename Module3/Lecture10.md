
# Module 3 — Distributed Systems
# Lecture 10: Distributed Locks, Fencing, and Concurrent Failure Testing

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [Why Distributed Locks Are Not Enough](#2-why-distributed-locks-are-not-enough)
3. [Understanding Fencing Tokens](#3-understanding-fencing-tokens)
4. [The Failure Scenario](#4-the-failure-scenario)
5. [Project Scope and Files](#5-project-scope-and-files)
6. [Implement a Fenced Resource Policy](#6-implement-a-fenced-resource-policy)
7. [Write the Unit Tests](#7-write-the-unit-tests)
8. [Test the Concurrent Failure Scenario](#8-test-the-concurrent-failure-scenario)
9. [Run the Tests](#9-run-the-tests)
10. [Intentionally Break the Implementation](#10-intentionally-break-the-implementation)
11. [Build and Verification](#11-build-and-verification)
12. [What We Have and Have Not Proven](#12-what-we-have-and-have-not-proven)
13. [Final Folder Structure](#13-final-folder-structure)
14. [Success Criteria](#14-success-criteria)
15. [Next Lecture](#15-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why acquiring a distributed lock does not guarantee that a process remains the legitimate owner forever.
- How a lease can expire while a process is paused.
- How fencing tokens protect a resource from stale leaders.
- Why a resource must enforce fencing instead of trusting the lock holder.
- How to write a deterministic test for a delayed, stale operation.
- Why an in-memory test is useful for learning but is not proof of distributed safety in production.

**Important scope:** This lecture adds an isolated policy and its tests. It does not modify `src/workers.ts`, start a leader runtime, or connect the new policy to PostgreSQL or Redis.

## 2. Why Distributed Locks Are Not Enough

Imagine two application instances running the same background operation.

- Instance A acquires a distributed lease.
- Instance A pauses for a long time because of a process stall, a network issue, or a long garbage-collection pause.
- Its lease expires.
- Instance B acquires a new lease and begins processing.
- Instance A resumes and continues executing code using its old lease information.

The lock service may correctly consider B the current leader, while A is still executing an old operation.

This is the key distinction:

**A lock controls permission to begin work; a fencing token helps the protected resource reject stale work.**

### The dangerous timeline

| Time | Instance A | Instance B |
|---|---|---|
| T1 | Acquires lease with token 41 | Waiting |
| T2 | Pauses unexpectedly | Waiting |
| T3 | Lease expires | Acquires lease with token 42 |
| T4 | Still paused | Writes new data using token 42 |
| T5 | Resumes with stale token 41 | Continues processing |
| T6 | Attempts an old write | Must not be overwritten by token 41 |

If the protected resource accepts every write from a process that *believes* it owns a lock, A may overwrite B's newer result.

A lease alone cannot prevent that scenario.

## 3. Understanding Fencing Tokens

A fencing token is a monotonically increasing number assigned when a new leadership tenure or lease is acquired.

Example:

| Leadership tenure | Fencing token |
|---|---:|
| First leader | 41 |
| Second leader | 42 |
| Third leader | 43 |

The protected resource remembers the highest fencing token it has accepted.

For each incoming write:

1. Read the incoming token.
2. Compare it with the highest accepted token for that resource.
3. Reject the write if its token is lower.
4. Accept the write if its token is equal to or greater than the stored token.
5. Update the highest token if the incoming token is greater.

Why allow an equal token? A legitimate leader normally performs multiple writes during one lease tenure. Its token does not have to increase for every individual operation.

Why reject a lower token? A process with token 41 must not overwrite data after the resource has already accepted token 42.

**Important limitation:** Fencing tokens protect against older leadership tenures. They do not automatically order two different operations from the same leader that use the same token.

## 4. The Failure Scenario

Suppose a resource initially contains:

```text
value = "initial"
highestToken = 0
```

Instance A holds token 41 but pauses before writing.

Instance B takes over and writes:

```text
token = 42
value = "new leader result"
```

The resource now contains:

```text
value = "new leader result"
highestToken = 42
```

Instance A resumes and tries:

```text
token = 41
value = "old leader result"
```

The write must be rejected. The final value must remain `"new leader result"`.

We will implement this rule as an isolated, in-memory policy so we can test the logic without modifying existing infrastructure.

## 5. Project Scope and Files

We will create only these two files:

```text
src/
└── services/
    └── fenced-resource.policy.ts

tests/
└── fenced-resource.policy.test.ts
```

We will not modify:

- `src/workers.ts`
- `src/server.ts`
- `src/services/leader-election.service.ts`
- Existing database migrations
- Existing Redis configuration
- Existing queue workers

The policy is independent of the current leader runtime and lease-provider adapter. No application startup wiring is required.

## 6. Implement a Fenced Resource Policy

### Step 1 — Create the policy file

**File: `src/services/fenced-resource.policy.ts`**

Create this file with the complete code below.

```typescript
export interface FencedWriteRequest {
  resourceId: string;
  fencingToken: number;
  value: string;
}

export interface FencedWriteResult {
  accepted: boolean;
  highestToken: number;
  reason: "accepted" | "stale-token";
}

interface ResourceState {
  highestToken: number;
  value: string;
}

export class FencedResourcePolicy {
  private readonly resources = new Map<string, ResourceState>();

  write(request: FencedWriteRequest): FencedWriteResult {
    const {
      resourceId,
      fencingToken,
      value
    } = request;

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

    const current = this.resources.get(resourceId);

    const highestToken = current?.highestToken ?? 0;

    if (fencingToken < highestToken) {
      return {
        accepted: false,
        highestToken,
        reason: "stale-token"
      };
    }

    this.resources.set(resourceId, {
      highestToken: Math.max(
        highestToken,
        fencingToken
      ),
      value
    });

    return {
      accepted: true,
      highestToken: Math.max(
        highestToken,
        fencingToken
      ),
      reason: "accepted"
    };
  }

  read(resourceId: string): ResourceState | null {
    const state = this.resources.get(resourceId);

    if (!state) {
      return null;
    }

    return { ...state };
  }
}
```

### Step 2 — Understand the implementation

**`resources`**

```typescript
private readonly resources = new Map<string, ResourceState>();
```

This map simulates the protected resource. Each resource ID has its own stored value and highest accepted token.

It is only in application memory. It is not a shared store across Node.js processes.

**The stale-token check**

```typescript
if (fencingToken < highestToken) {
  return {
    accepted: false,
    highestToken,
    reason: "stale-token"
  };
}
```

If the resource has already accepted token 42, a write using token 41 is rejected.

**Why not reject equal tokens?**

```typescript
if (fencingToken < highestToken)
```

We reject strictly lower tokens. The same leader tenure may legitimately submit multiple writes with the same token.

**Why use `Math.max`?**

```typescript
highestToken: Math.max(
  highestToken,
  fencingToken
)
```

The remembered token must never move backwards.

## 7. Write the Unit Tests

### Step 1 — Create the test file

**File: `tests/fenced-resource.policy.test.ts`**

Create this file with the complete code below.

```typescript
import { describe, expect, it } from "vitest";

import {
  FencedResourcePolicy
} from "../src/services/fenced-resource.policy.js";

describe("FencedResourcePolicy", () => {
  it("accepts the first valid write", () => {
    const resource = new FencedResourcePolicy();

    const result = resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "leader-A"
    });

    expect(result).toEqual({
      accepted: true,
      highestToken: 41,
      reason: "accepted"
    });

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 41,
      value: "leader-A"
    });
  });

  it("allows multiple writes with the same token", () => {
    const resource = new FencedResourcePolicy();

    resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "first-write"
    });

    const secondWrite = resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "second-write"
    });

    expect(secondWrite.accepted).toBe(true);

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 41,
      value: "second-write"
    });
  });

  it("rejects a token older than the highest accepted token", () => {
    const resource = new FencedResourcePolicy();

    resource.write({
      resourceId: "account-1001",
      fencingToken: 42,
      value: "new-leader"
    });

    const staleWrite = resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "old-leader"
    });

    expect(staleWrite).toEqual({
      accepted: false,
      highestToken: 42,
      reason: "stale-token"
    });

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 42,
      value: "new-leader"
    });
  });

  it("tracks fencing tokens independently per resource", () => {
    const resource = new FencedResourcePolicy();

    resource.write({
      resourceId: "account-1001",
      fencingToken: 42,
      value: "account-one"
    });

    const secondResourceWrite = resource.write({
      resourceId: "account-2002",
      fencingToken: 7,
      value: "account-two"
    });

    expect(secondResourceWrite.accepted).toBe(true);

    expect(
      resource.read("account-2002")
    ).toEqual({
      highestToken: 7,
      value: "account-two"
    });
  });

  it("rejects invalid fencing tokens", () => {
    const resource = new FencedResourcePolicy();

    expect(() =>
      resource.write({
        resourceId: "account-1001",
        fencingToken: 0,
        value: "invalid"
      })
    ).toThrow(
      "fencingToken must be a positive safe integer"
    );

    expect(() =>
      resource.write({
        resourceId: "account-1001",
        fencingToken: Number.NaN,
        value: "invalid"
      })
    ).toThrow(
      "fencingToken must be a positive safe integer"
    );
  });

  it("rejects an empty resource ID", () => {
    const resource = new FencedResourcePolicy();

    expect(() =>
      resource.write({
        resourceId: "   ",
        fencingToken: 41,
        value: "invalid"
      })
    ).toThrow("resourceId must not be empty");
  });

  it("rejects an old leader after a newer leader writes", async () => {
    const resource = new FencedResourcePolicy();

    let releaseOldLeader!: () => void;

    const oldLeaderMayContinue = new Promise<void>(
      (resolve) => {
        releaseOldLeader = resolve;
      }
    );

    const oldLeaderWrite = (async () => {
      // Simulate leader A pausing while it holds token 41.
      await oldLeaderMayContinue;

      return resource.write({
        resourceId: "account-1001",
        fencingToken: 41,
        value: "old-leader-result"
      });
    })();

    // Leader B has taken over and writes with token 42.
    const newLeaderWrite = resource.write({
      resourceId: "account-1001",
      fencingToken: 42,
      value: "new-leader-result"
    });

    expect(newLeaderWrite.accepted).toBe(true);

    // Allow the delayed operation from leader A to resume.
    releaseOldLeader();

    const staleResult = await oldLeaderWrite;

    expect(staleResult).toEqual({
      accepted: false,
      highestToken: 42,
      reason: "stale-token"
    });

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 42,
      value: "new-leader-result"
    });
  });
});
```

### Step 2 — Understand the concurrent test

The test creates a promise that prevents the old leader from writing immediately.

1. Leader A begins its operation with token 41 and pauses.
2. Leader B writes successfully with token 42.
3. The test releases leader A.
4. Leader A resumes and attempts its stale write.
5. The resource rejects token 41.
6. The final value remains the newer leader's result.

The test deliberately controls the order of operations. This makes the failure scenario repeatable instead of depending on unpredictable timing.

## 8. Test the Concurrent Failure Scenario

The critical invariant is:

> Once the protected resource has accepted a higher fencing token, an operation with a lower token cannot overwrite its state.

The test verifies both the rejection response and the final stored value.

This matters because checking only the return value is insufficient. A faulty implementation could report rejection but accidentally mutate the resource anyway.

We therefore assert both:

```typescript
expect(staleResult.accepted).toBe(false);

expect(resource.read("account-1001")).toEqual({
  highestToken: 42,
  value: "new-leader-result"
});
```

## 9. Run the Tests

Run the commands from your project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

### Step 1 — Run only the new tests

**PowerShell**

```powershell
npm run test:run -- tests/fenced-resource.policy.test.ts
```

Expected result: all seven tests pass.

### Step 2 — If the focused tests fail

Do not change `src/workers.ts`.

Read the first failure carefully and verify:

- The test imports `../src/services/fenced-resource.policy.js`.
- The implementation file is at `src/services/fenced-resource.policy.ts`.
- The test file is at `tests/fenced-resource.policy.test.ts`.
- The test runner is using your existing Vitest configuration.

Fix the actual reported problem before continuing.

### Step 3 — Run the complete test suite

Only after the focused test passes:

```powershell
npm run test:run
```

This can reveal regressions in the existing project. Do not assume the full suite passes just because the new tests pass.

## 10. Intentionally Break the Implementation

We will deliberately introduce a bug, observe the failing test, and restore the correct implementation.

### Break the stale-token rule

**File: `src/services/fenced-resource.policy.ts`**

Find this condition:

```typescript
if (fencingToken < highestToken) {
```

Temporarily replace it with:

```typescript
if (fencingToken > highestToken) {
```

Now run:

```powershell
npm run test:run -- tests/fenced-resource.policy.test.ts
```

The stale-token tests should fail because the implementation now rejects newer tokens instead of rejecting older ones.

### Fix the bug

Restore the original condition:

```typescript
if (fencingToken < highestToken) {
```

Run the focused tests again:

```powershell
npm run test:run -- tests/fenced-resource.policy.test.ts
```

Expected result: all seven tests pass.

Do not leave the intentionally broken condition in your code.

## 11. Build and Verification

Run the TypeScript build using your existing project script:

```powershell
npm run build
```

If the build fails, investigate the reported TypeScript error. Do not change unrelated queue, Redis, database, or worker files to make this isolated exercise pass.

If the build and tests both succeed, this proves the new policy compiles and its modeled behavior matches the tests. It does **not** prove that the actual distributed system is safe yet.

## 12. What We Have and Have Not Proven

### What we have proven in this exercise

- The policy rejects a token lower than the highest token already accepted for that resource.
- Repeated writes with the same token are allowed.
- A stale write does not change the modeled resource state.
- The test can reproduce the delayed-old-leader scenario deterministically.
- Invalid tokens and empty resource IDs are rejected.

### What we have not proven

The `Map` in this exercise is local to one JavaScript process. Two Node.js processes would not share its state.

Therefore, this policy is an educational model, not a production distributed lock implementation.

For production, the protected resource must enforce the fencing rule atomically. For example, PostgreSQL can compare and update the stored fencing token inside a transaction or a conditional SQL statement. The comparison and data mutation must not be separate, unprotected operations.

Also, a fencing token protects against stale leadership only if:

1. New leadership tenures receive tokens that are strictly increasing in the relevant token domain.
2. The protected resource actually validates the token.
3. The resource's token check and protected mutation are atomic.
4. All relevant writers follow the enforcement rule.

**Do not connect this in-memory policy to your production workers or treat it as a substitute for PostgreSQL enforcement.**

## 13. Final Folder Structure

After creating the two files, the relevant portion of your project should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── services/
│   │   ├── fenced-resource.policy.ts       # NEW
│   │   ├── leader-election.service.ts      # Existing; unchanged
│   │   └── ...
│   ├── workers.ts                          # Unchanged
│   └── ...
├── tests/
│   ├── fenced-resource.policy.test.ts      # NEW
│   └── ...
├── package.json                            # Unchanged
└── ...
```

The ellipses represent existing files; do not create placeholder files for them.

## 14. Success Criteria

- [ ] Created `src/services/fenced-resource.policy.ts`.
- [ ] Created `tests/fenced-resource.policy.test.ts`.
- [ ] Did not modify `src/workers.ts`.
- [ ] All seven focused tests pass.
- [ ] The complete test suite passes, or any failures are investigated and documented.
- [ ] The TypeScript build passes, or any errors are investigated and documented.
- [ ] Restored the correct stale-token comparison after the intentional break.
- [ ] Understand that this is an in-memory model, not production-grade distributed enforcement.

## 15. Next Lecture

**Module 3 — Lecture 11: Atomic Fencing Enforcement in PostgreSQL**

Next, we will move from the in-memory model to an atomic database-backed rule. We will examine how to reject stale fencing tokens at the database boundary, how concurrent writes interact, and how to test the database behavior without wiring anything into `src/workers.ts` prematurely.
