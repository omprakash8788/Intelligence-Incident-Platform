# Module 3 — Lecture 19: Distributed Systems Integration Testing

## Table of Contents

1. Learning objectives
2. Unit tests vs. integration tests
3. What we need to prove
4. Project scope
5. Build a reusable retry policy
6. Write integration-style tests with controlled failures
7. Build and test
8. Intentional break, root cause, fix, and retest
9. Failure-injection scenarios
10. What this does not prove
11. Final folder structure
12. Success criteria
13. Next lecture

---

## 1. Learning objectives

By the end of this lecture, you should understand how to:

- Distinguish a unit test from an integration test.
- Inject failures deterministically rather than depending on random network errors.
- Test retry behavior and verify how many times an operation executes.
- Verify that retry exhaustion produces a clear failure.
- Test recovery without sleeping for long periods.
- Understand what additional testing is required for PostgreSQL, Redis, BullMQ, and distributed leases.

Our first exercise will test an important building block of distributed systems: **retrying a transient operation without retrying forever**.

We will then use injected failures to simulate realistic outcomes. This is an integration-testing foundation, not a claim that a mocked test proves the behavior of a real distributed system.

## 2. Unit tests vs. integration tests

### Unit test

A unit test checks a small unit in isolation.

Examples:

- Does a retry policy calculate the correct delay?
- Does a crash-window policy return the expected recovery action?
- Does an idempotency helper reject a mismatched request hash?

### Integration test

An integration test checks whether multiple real components work together.

Examples:

- Does an application write to PostgreSQL and roll back correctly after a failure?
- Does a BullMQ worker consume a job from Redis?
- Does a lease renewal update the PostgreSQL lease correctly?
- Can two independent processes compete for leadership without both performing protected work?

### Failure-injection test

A failure-injection test deliberately creates an error at a specific point in a workflow.

Examples:

- Fail the first two attempts and let the third succeed.
- Terminate a publisher after destination acceptance but before the acknowledgement is saved.
- Stop Redis while a worker is processing a job.
- Expire a leader's lease while its task is still running.

A failure-injection test can be a unit test or an integration test. The distinction depends on whether the relevant real components are involved.

**Our exercise:** we will implement a retry helper and test it with a deterministic fake operation. This is an isolated test of failure handling. Later, the same testing approach can be used against actual PostgreSQL, Redis, and BullMQ components.

## 3. What we need to prove

Consider a task that calls an external service.

```text
Attempt 1
   |
   X Temporary failure
   |
Attempt 2
   |
   X Temporary failure
   |
Attempt 3
   |
   v
Success
```

A reliable retry mechanism needs to answer four questions:

1. Which errors are retryable?
2. How many attempts are permitted?
3. How long should the system wait between attempts?
4. What happens when all attempts fail?

We will build a helper that makes these decisions explicit.

### Important safety rule

Retries do not automatically make an operation safe.

If an operation charges a payment card, sends an email, or applies a database update, retrying it may repeat the side effect. For non-idempotent operations, use an idempotency key or another mechanism that makes repeated attempts safe.

Our helper will accept an operation supplied by the caller. It will not assume that the operation is idempotent.

## 4. Project scope

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Create these files:

- `src/services/retry-operation.ts`
- `tests/retry-operation.test.ts`

### This lecture will not:

- Modify `src/workers.ts`.
- Modify any existing database migration.
- Create a new database table.
- Connect the helper directly to BullMQ.
- Claim to verify real Redis or PostgreSQL failure recovery.

We will first test the retry mechanism in isolation. After this passes, it can become a candidate for integration into an actual service after that service's current retry behavior is inspected.

## 5. Build a reusable retry policy

### File: `src/services/retry-operation.ts`

**Action:** Create this file.

```typescript
export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  shouldRetry: (error: unknown) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly originalError: unknown;

  constructor(attempts: number, originalError: unknown) {
    super(`Operation failed after ${attempts} attempts`);

    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.originalError = originalError;
  }
}

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    delayMs,
    shouldRetry,
    wait = defaultWait
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a non-negative number");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await operation(attempt);

      return {
        value,
        attempts: attempt
      };
    } catch (error: unknown) {
      lastError = error;

      const attemptsRemain = attempt < maxAttempts;

      if (!attemptsRemain || !shouldRetry(error)) {
        break;
      }

      await wait(delayMs);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}
```

### How it works

- `maxAttempts` is the total number of attempts, including the first attempt.
- `shouldRetry` decides whether the encountered error is eligible for another attempt.
- `wait` controls the delay between attempts.
- The optional `wait` dependency allows tests to avoid real waiting.
- The result includes both the successful value and the number of attempts used.
- `RetryExhaustedError` exposes the last error for diagnostics.

For example, with `maxAttempts: 3`, the helper makes at most three attempts. It does not make one initial attempt plus three retries.

### Important implementation detail

The helper uses `unknown` for errors because JavaScript permits throwing values other than `Error` objects.

One limitation to notice: the current implementation uses `RetryExhaustedError` for both retry exhaustion and a non-retryable failure. It preserves the original error in `originalError`, but a production implementation might use a separate error type or rethrow non-retryable errors unchanged. We will improve this behavior in the next exercise.

## 6. Write tests with controlled failures

### File: `tests/retry-operation.test.ts`

**Action:** Create this file.

```typescript
import { describe, expect, it, vi } from "vitest";

import {
  RetryExhaustedError,
  retryOperation
} from "../src/services/retry-operation.js";

describe("retryOperation", () => {
  it("succeeds on the first attempt", async () => {
    const operation = vi.fn(async () => "success");
    const wait = vi.fn(async () => undefined);

    const result = await retryOperation(operation, {
      maxAttempts: 3,
      delayMs: 100,
      shouldRetry: () => true,
      wait
    });

    expect(result).toEqual({
      value: "success",
      attempts: 1
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries transient failures and then succeeds", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("success");

    const wait = vi.fn(async () => undefined);

    const result = await retryOperation(operation, {
      maxAttempts: 3,
      delayMs: 50,
      shouldRetry: () => true,
      wait
    });

    expect(result).toEqual({
      value: "success",
      attempts: 3
    });

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 50);
    expect(wait).toHaveBeenNthCalledWith(2, 50);
  });

  it("stops when the retry limit is reached", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("service unavailable"));

    const wait = vi.fn(async () => undefined);

    let caughtError: unknown;

    try {
      await retryOperation(operation, {
        maxAttempts: 3,
        delayMs: 25,
        shouldRetry: () => true,
        wait
      });
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(RetryExhaustedError);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);

    expect(
      (caughtError as RetryExhaustedError).attempts
    ).toBe(3);

    expect(
      (caughtError as RetryExhaustedError).originalError
    ).toEqual(new Error("service unavailable"));
  });

  it("does not retry a non-retryable error", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("invalid request"));

    const wait = vi.fn(async () => undefined);

    await expect(
      retryOperation(operation, {
        maxAttempts: 5,
        delayMs: 100,
        shouldRetry: () => false,
        wait
      })
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects an invalid attempt limit", async () => {
    await expect(
      retryOperation(async () => "success", {
        maxAttempts: 0,
        delayMs: 100,
        shouldRetry: () => true
      })
    ).rejects.toThrow(
      "maxAttempts must be a positive integer"
    );
  });

  it("rejects a negative delay", async () => {
    await expect(
      retryOperation(async () => "success", {
        maxAttempts: 3,
        delayMs: -1,
        shouldRetry: () => true
      })
    ).rejects.toThrow(
      "delayMs must be a non-negative number"
    );
  });
});
```

### What these tests establish

The fake operation lets us decide exactly when the operation fails and succeeds.

We can verify:

- The number of calls.
- The number of waits.
- Whether retry exhaustion occurs.
- Whether a non-retryable error stops additional attempts.
- Whether invalid configuration is rejected.

The injected `wait` function is important. Tests do not need to sleep for 50 or 100 milliseconds between attempts, so they remain fast and deterministic.

## 7. Build and test

Run these commands from the project root.

### Step 1 — Run only this test file

```powershell
npm run test:run -- tests/retry-operation.test.ts
```

Expected result: six tests pass.

### Step 2 — Build TypeScript

```powershell
npm run build
```

Expected result: compilation completes without errors.

### Step 3 — Run the full unit-test suite

```powershell
npm run test:run
```

Expected result: this lecture's tests and your existing tests pass.

If your project uses different script names, inspect the scripts already present in `package.json` and use the corresponding existing commands. Do not replace your scripts just for this lecture.

## 8. Intentional break, root cause, fix, and retest

We will introduce an off-by-one error in the retry loop.

### Step 1 — Break the code

**File:** `src/services/retry-operation.ts`

Find:

```typescript
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
```

Temporarily replace it with:

```typescript
for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
```

### Step 2 — Run the targeted tests

```powershell
npm run test:run -- tests/retry-operation.test.ts
```

The tests expecting three attempts should fail because the loop now executes only two attempts when `maxAttempts` is three.

### Step 3 — Root cause

The configured maximum is inclusive.

For `maxAttempts = 3`, the intended attempt values are:

```text
1, 2, 3
```

But the incorrect comparison `attempt < maxAttempts` permits only:

```text
1, 2
```

This bug silently reduces the retry budget and can cause transient operations to fail earlier than intended.

### Step 4 — Fix the code

**File:** `src/services/retry-operation.ts`

Restore:

```typescript
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
```

### Step 5 — Retest

```powershell
npm run test:run -- tests/retry-operation.test.ts
npm run build
```

The targeted tests should pass again if the code matches the implementation above.

## 9. Failure-injection scenarios

Before integrating retry logic into infrastructure, reason through the following scenarios.

### Scenario A — A transient HTTP error

The destination returns a temporary service error twice, then succeeds.

Expected behavior:

- Retry only if the error is classified as retryable.
- Stop when the operation succeeds.
- Record the number of attempts.

### Scenario B — A validation error

The destination rejects the request because a required field is missing.

Expected behavior:

- Classify it as non-retryable.
- Do not repeatedly send the same invalid request.
- Surface the failure to the caller.

### Scenario C — A database commit with an unknown outcome

The client loses its connection while committing a transaction.

Expected behavior:

- Do not assume that the transaction rolled back.
- Resolve the outcome through durable state or an idempotent retry mechanism.
- Avoid repeating an unprotected business effect.

### Scenario D — The destination accepted a message but the publisher timed out

Expected behavior:

- Treat the outcome as unknown.
- Retry only under an appropriate delivery policy.
- Use a stable event identifier and destination-side deduplication if duplicate business effects are unacceptable.

### Scenario E — A lease expires during an in-flight operation

Expected behavior:

- Recognize that the original operation may still be running.
- Do not rely on the lease alone to prevent duplicate external effects.
- Use appropriate cancellation, fencing, and idempotency mechanisms.

## 10. What this does not prove

Passing this lecture's tests proves only that the retry helper follows its tested rules.

It does not prove:

- PostgreSQL transactions roll back correctly in your application.
- Redis outages are handled correctly.
- BullMQ jobs resume or retry correctly.
- A stale leader is prevented from writing.
- An outbox event is published exactly once.
- External side effects are deduplicated.
- A process crash between two real operations is recovered safely.

Those claims require tests that use the actual components and inject failures at controlled points.

A real integration-testing progression should be:

1. Test pure policies.
2. Test service logic with controlled dependencies.
3. Test database transactions against a real test database.
4. Test Redis and BullMQ using a dedicated test environment.
5. Test concurrent processes and lease expiration.
6. Inject crashes between delivery and acknowledgement.
7. Verify durable state after recovery.

## 11. Final folder structure

The relevant new files should be:

```text
production-intelligence-platform/
├── src/
│   ├── services/
│   │   └── retry-operation.ts
│   ├── workers.ts
│   └── server.ts
└── tests/
    └── retry-operation.test.ts
```

This is a partial view of your project. Preserve all existing source files and migration files.

No `workers.ts` edits are required for this lecture.

## 12. Success criteria

- [ ] Created `src/services/retry-operation.ts`.
- [ ] Created `tests/retry-operation.test.ts`.
- [ ] Verified first-attempt success.
- [ ] Verified transient failure followed by success.
- [ ] Verified retry exhaustion.
- [ ] Verified non-retryable errors stop additional attempts.
- [ ] Verified invalid configuration is rejected.
- [ ] Performed the intentional off-by-one break.
- [ ] Observed the expected test failure.
- [ ] Restored the correct loop condition and reran the tests.
- [ ] Ran the build and full test suite.
- [ ] Left `src/workers.ts` unchanged.

## 13. Next lecture

**Module 3 — Lecture 20: Capstone — Production-Grade Leader and Worker Coordination**

The capstone will bring together leadership, leases, fencing, safe work execution, idempotency, graceful shutdown, and failure recovery. Before making any integration changes, we must inspect the actual files and tests in your project rather than assuming every proposed lecture file has been implemented.