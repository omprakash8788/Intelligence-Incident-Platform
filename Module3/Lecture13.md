
# Module 3 — Distributed Systems
# Lecture 13: Lease Loss During In-Flight Work

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [The Problem: Losing a Lease During Work](#2-the-problem-losing-a-lease-during-work)
3. [Stopping New Work vs. Cancelling Existing Work](#3-stopping-new-work-vs-cancelling-existing-work)
4. [The Correct Safety Model](#4-the-correct-safety-model)
5. [Project Scope and File Structure](#5-project-scope-and-file-structure)
6. [Implement a Lease Work Scope](#6-implement-a-lease-work-scope)
7. [Write Unit Tests](#7-write-unit-tests)
8. [Test Lease Loss During Work](#8-test-lease-loss-during-work)
9. [Intentionally Break the Implementation](#9-intentionally-break-the-implementation)
10. [Build and Verification](#10-build-and-verification)
11. [Production Considerations](#11-production-considerations)
12. [Final Folder Structure](#12-final-folder-structure)
13. [Success Criteria](#13-success-criteria)
14. [Next Lecture](#14-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- What happens when a leader loses its lease while a task is already running.
- Why stopping new work does not automatically stop in-flight work.
- How JavaScript's `AbortController` and `AbortSignal` support cooperative cancellation.
- Why cancellation cannot undo a database write or external API request that has already completed.
- How fencing tokens protect the resource even if stale work continues.
- How to test lease-loss behavior without integrating the code into your production workers.

**Important:** This lecture introduces an isolated, testable utility. It does not modify `src/workers.ts`, the existing leader runtime, your database pool, or your migration files.

## 2. The Problem: Losing a Lease During Work

Imagine that your application has two instances.

- Instance A acquires leadership with fencing token `41`.
- Instance A starts processing a long-running job.
- Instance A loses its lease because renewal fails or the lease expires.
- Instance B acquires leadership with fencing token `42`.
- Instance A's job is still executing.

The problem is that **losing a lease does not automatically terminate JavaScript that is already running**.

For example, a task might be:

1. Download a file.
2. Transform the file.
3. Send a request to an external API.
4. Write the result to PostgreSQL.

If leadership is lost after step 2, the remaining steps may still run unless the task cooperates with cancellation or the protected resource rejects stale operations.

### Failure timeline

```text
Instance A                         Instance B
----------                         ----------
Acquires token 41
Starts a long-running job
                                   Acquires token 42
Lease renewal fails
Receives lease-loss signal
Job is still running
                                   Writes new result
Old job attempts database write
                                   Database rejects token 41
```

The system needs two protections:

1. **Cancellation:** Ask the old task to stop unnecessary work.
2. **Fencing:** Prevent stale work from corrupting protected state if it continues anyway.

Cancellation improves efficiency. Fencing enforces resource-level safety.

## 3. Stopping New Work vs. Cancelling Existing Work

These are different operations.

| Operation | Meaning |
|---|---|
| Stop accepting work | Do not start additional jobs |
| Cancel in-flight work | Ask already-running jobs to stop |
| Fence stale writes | Reject writes from an older leadership tenure |
| Compensate for completed effects | Undo or counteract an effect when the business workflow supports it |

A worker may stop accepting new jobs but still have active jobs running.

Similarly, aborting an `AbortController` only signals cancellation. It does not forcibly terminate arbitrary JavaScript, roll back an already committed database transaction, or recall an HTTP request that the remote server has already processed.

**Never treat an abort signal as proof that a task has stopped.**

## 4. The Correct Safety Model

Our isolated utility will represent a scope of work tied to a particular lease.

The scope can be in one of two states:

- `active`: Work may continue.
- `aborted`: The lease has been lost, and the cancellation signal has fired.

The rules are:

1. A new task may start only while the scope is active.
2. When leadership is lost, abort the scope.
3. Tasks that support cancellation should check the signal and stop safely.
4. Tasks that cannot be cancelled must still protect their writes using fencing, idempotency, or another suitable resource-level mechanism.
5. A new leadership tenure should use a separate scope. Do not reactivate an aborted scope.

We will implement these rules in a small class and test them independently.

## 5. Project Scope and File Structure

Create two new files:

```text
src/
└── services/
    └── lease-work-scope.ts

tests/
└── lease-work-scope.test.ts
```

We will not create or modify a SQL migration. This utility does not need a database table.

We will also leave these files unchanged:

- `src/workers.ts`
- `src/server.ts`
- `src/database/pool.ts`
- `src/database/migrations/*`
- Existing leader-election and lease-provider services

## 6. Implement a Lease Work Scope

### Step 1 — Create the service file

**File: `src/services/lease-work-scope.ts`**

Create this file with the complete code below.

```typescript
export type LeaseWorkState =
  | "active"
  | "aborted";

export class LeaseWorkScope {
  private readonly controller = new AbortController();

  private state: LeaseWorkState = "active";

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  getState(): LeaseWorkState {
    return this.state;
  }

  canStartWork(): boolean {
    return this.state === "active";
  }

  loseLease(reason?: unknown): void {
    if (this.state === "aborted") {
      return;
    }

    this.state = "aborted";

    this.controller.abort(
      reason ??
        new Error("Leadership lease was lost")
    );
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) {
      return;
    }

    throw this.signal.reason ??
      new Error("Work scope has been aborted");
  }
}
```

### Step 2 — Understand each method

#### `signal`

```typescript
get signal(): AbortSignal {
  return this.controller.signal;
}
```

The task receives this signal and can listen for cancellation.

#### `canStartWork()`

```typescript
canStartWork(): boolean {
  return this.state === "active";
}
```

This gives the caller a way to check whether the scope still permits starting work.

This is a local state check, not a substitute for checking actual lease ownership with the authoritative lease provider.

#### `loseLease()`

```typescript
loseLease(reason?: unknown): void {
  if (this.state === "aborted") {
    return;
  }

  this.state = "aborted";

  this.controller.abort(
    reason ??
      new Error("Leadership lease was lost")
  );
}
```

The method marks the scope as aborted and signals cancellation.

Calling it repeatedly is safe: only the first call performs the transition.

#### `throwIfAborted()`

```typescript
throwIfAborted(): void {
  if (!this.signal.aborted) {
    return;
  }

  throw this.signal.reason ??
    new Error("Work scope has been aborted");
}
```

A cooperative task can call this between processing steps. If leadership has been lost, the method throws instead of allowing the task to proceed.

It cannot interrupt a synchronous function in the middle of execution. The task must reach a cancellation check.

## 7. Write Unit Tests

### Step 1 — Create the test file

**File: `tests/lease-work-scope.test.ts`**

Create this file with the complete code below.

```typescript
import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  LeaseWorkScope
} from "../src/services/lease-work-scope.js";

describe("LeaseWorkScope", () => {
  it("starts in the active state", () => {
    const scope = new LeaseWorkScope();

    expect(scope.getState()).toBe("active");
    expect(scope.canStartWork()).toBe(true);
    expect(scope.signal.aborted).toBe(false);
  });

  it("aborts when the lease is lost", () => {
    const scope = new LeaseWorkScope();

    scope.loseLease();

    expect(scope.getState()).toBe("aborted");
    expect(scope.canStartWork()).toBe(false);
    expect(scope.signal.aborted).toBe(true);
  });

  it("notifies listeners when the lease is lost", () => {
    const scope = new LeaseWorkScope();
    const listener = vi.fn();

    scope.signal.addEventListener(
      "abort",
      listener
    );

    scope.loseLease();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not abort twice", () => {
    const scope = new LeaseWorkScope();
    const listener = vi.fn();

    scope.signal.addEventListener(
      "abort",
      listener
    );

    scope.loseLease();
    scope.loseLease();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(scope.getState()).toBe("aborted");
  });

  it("throws when work checks an aborted scope", () => {
    const scope = new LeaseWorkScope();

    scope.loseLease();

    expect(() => {
      scope.throwIfAborted();
    }).toThrow("Leadership lease was lost");
  });

  it("does not throw while the scope is active", () => {
    const scope = new LeaseWorkScope();

    expect(() => {
      scope.throwIfAborted();
    }).not.toThrow();
  });

  it("allows cooperative work to stop after lease loss", async () => {
    const scope = new LeaseWorkScope();

    const steps: string[] = [];

    const task = async (): Promise<void> => {
      scope.throwIfAborted();
      steps.push("download");

      scope.throwIfAborted();
      steps.push("transform");

      scope.throwIfAborted();
      steps.push("write");
    };

    scope.loseLease();

    await expect(task()).rejects.toThrow(
      "Leadership lease was lost"
    );

    expect(steps).toEqual([]);
  });

  it("does not reactivate after lease loss", () => {
    const scope = new LeaseWorkScope();

    scope.loseLease();

    expect(scope.canStartWork()).toBe(false);
    expect(scope.getState()).toBe("aborted");
  });
});
```

### Step 2 — Understand the tests

The tests cover three categories.

**State tests**

They verify that the scope begins active and transitions to aborted when the lease is lost.

**Signal tests**

They verify that listeners are notified and repeated calls do not notify them twice.

**Cooperative-work tests**

They verify that code checking the signal can stop before performing later steps.

The cooperative-work test aborts before the task begins, so no processing steps execute.

We will now add a test that loses the lease after work has already started.

## 8. Test Lease Loss During Work

### Step 1 — Add a test for an in-flight task

**File: `tests/lease-work-scope.test.ts`**

Inside the existing `describe("LeaseWorkScope", ...)` block, add this test before the final closing `});`.

Do not replace the entire file; this is an additional test.

```typescript
it("stops an in-flight cooperative task after lease loss", async () => {
  const scope = new LeaseWorkScope();

  let markStarted!: () => void;

  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const steps: string[] = [];

  const task = async (): Promise<void> => {
    steps.push("started");
    markStarted();

    // Simulate an asynchronous operation already in progress.
    await new Promise<void>((resolve) => {
      scope.signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true }
      );
    });

    // The task must check cancellation before continuing.
    scope.throwIfAborted();

    steps.push("write");
  };

  const taskPromise = task();

  await started;

  expect(steps).toEqual(["started"]);

  scope.loseLease();

  await expect(taskPromise).rejects.toThrow(
    "Leadership lease was lost"
  );

  expect(steps).toEqual(["started"]);
});
```

### Step 2 — What happens in this test?

1. The task starts.
2. It records that it has started.
3. The task waits for the abort signal.
4. The test simulates lease loss.
5. The signal wakes the task.
6. The task checks the scope.
7. The check throws, preventing the later `write` step.

This demonstrates cooperative cancellation of an in-flight task.

The example uses an abort listener to simulate an asynchronous operation that can respond to cancellation. A real database query or external API call may not stop immediately just because an abort signal fires.

## 9. Intentionally Break the Implementation

We will deliberately break cancellation to understand why the state transition matters.

### Step 1 — Remove the state transition

**File: `src/services/lease-work-scope.ts`**

Find this line inside `loseLease()`:

```typescript
this.state = "aborted";
```

Temporarily remove it.

Keep the `controller.abort(...)` call.

### Step 2 — Run the focused tests

From your project root, run:

```powershell
npm run test:run -- tests/lease-work-scope.test.ts
```

The tests checking `getState()` and `canStartWork()` should fail because the scope still reports that it is active even though the abort signal has fired.

### Step 3 — Restore the state transition

Restore:

```typescript
this.state = "aborted";
```

Run the focused tests again:

```powershell
npm run test:run -- tests/lease-work-scope.test.ts
```

Expected result: all nine tests pass.

Do not leave the broken implementation in place.

## 10. Build and Verification

### Step 1 — Run the focused tests

```powershell
npm run test:run -- tests/lease-work-scope.test.ts
```

Expected result: all nine tests pass.

### Step 2 — Run the full test suite

```powershell
npm run test:run
```

Investigate any failures instead of assuming they are unrelated.

### Step 3 — Run the TypeScript build

```powershell
npm run build
```

If the project uses a different build script, follow the existing `package.json`.

Do not modify the database migrations, PostgreSQL pool, or worker startup code to resolve an unrelated test failure.

## 11. Production Considerations

This utility is a building block, not a complete lease-management system.

### 11.1 A task must cooperate

A task that never checks its signal can continue running.

For example:

```typescript
while (true) {
  doExpensiveWork();
}
```

If `doExpensiveWork()` never returns, JavaScript cannot process an abort event until control returns to the event loop. A CPU-intensive synchronous loop can block the process entirely.

Long-running tasks need bounded work units, cancellation checks, or an execution mechanism that can be safely terminated.

### 11.2 Cancellation does not reverse completed effects

If an external API has already processed a request, aborting locally does not guarantee that the remote operation is undone.

Likewise, a database transaction that has already committed cannot be rolled back by subsequently aborting an `AbortController`.

For important external side effects, use the appropriate combination of:

- Idempotency keys.
- Fencing at the resource boundary.
- Transactions where applicable.
- Explicit compensation when the business operation supports it.

### 11.3 Fencing is still required

Even after the task receives an abort signal, it may be delayed, may not support cancellation, or may already have sent a request.

Protected writes must still reject stale fencing tokens.

For example, a task from token 41 must not overwrite a database resource that has already accepted token 42.

### 11.4 A new leadership tenure needs a new scope

Once a `LeaseWorkScope` is aborted, it stays aborted.

A newly elected leader should receive a fresh scope for its own tenure. Reusing the old scope would incorrectly prevent the new leader from starting work.

### 11.5 This is not wired into your application

The class created here is not imported by `src/workers.ts` or your leader runtime.

That is intentional. We are verifying the cancellation primitive first. Integration requires checking the actual runtime lifecycle and the worker's job-processing contract.

## 12. Final Folder Structure

After completing the lecture, the relevant structure should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/                 # Existing; unchanged
│   │   └── pool.ts                     # Existing; unchanged
│   ├── services/
│   │   └── lease-work-scope.ts         # NEW
│   └── workers.ts                      # Unchanged
└── tests/
    └── lease-work-scope.test.ts        # NEW
```

No new migration is required.

No existing service needs to be modified for this isolated exercise.

## 13. Success Criteria

- [ ] Created `src/services/lease-work-scope.ts`.
- [ ] Created `tests/lease-work-scope.test.ts`.
- [ ] All nine focused tests pass.
- [ ] The full test suite has been run.
- [ ] The TypeScript build has been run.
- [ ] Restored the implementation after the intentional break.
- [ ] Understand that abort signals request cooperative cancellation.
- [ ] Understand that an abort signal cannot undo a completed side effect.
- [ ] Understand why stale writes still require fencing.
- [ ] Left `src/workers.ts` unchanged.
- [ ] Left `src/database/migrations/` unchanged.

## 14. Next Lecture

**Module 3 — Lecture 14: Graceful Cancellation and Safe Task Shutdown**

Next, we will distinguish cancelling one task from shutting down a worker process. We will examine how to stop accepting new jobs, signal active jobs, wait for a bounded shutdown period, and handle jobs that do not finish before the deadline.

We will keep the exercises isolated until the relevant worker lifecycle code is verified against your actual project.
