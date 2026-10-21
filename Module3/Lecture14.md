
# Module 3 — Distributed Systems
# Lecture 14: Graceful Cancellation and Safe Task Shutdown

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [Why Graceful Shutdown Matters](#2-why-graceful-shutdown-matters)
3. [The Correct Shutdown Sequence](#3-the-correct-shutdown-sequence)
4. [Design Decisions](#4-design-decisions)
5. [Project Scope and Folder Structure](#5-project-scope-and-folder-structure)
6. [Implement the Shutdown Coordinator](#6-implement-the-shutdown-coordinator)
7. [Write the Unit Tests](#7-write-the-unit-tests)
8. [Test the Shutdown Timeout](#8-test-the-shutdown-timeout)
9. [Intentionally Break the Implementation](#9-intentionally-break-the-implementation)
10. [Build and Verification](#10-build-and-verification)
11. [Production Considerations](#11-production-considerations)
12. [Final Folder Structure](#12-final-folder-structure)
13. [Success Criteria](#13-success-criteria)
14. [Next Lecture](#14-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a worker must stop accepting new jobs before it shuts down.
- How to signal cancellation to active jobs.
- Why shutdown must have a deadline.
- How to close resources even if an active job does not finish in time.
- Why timing out while waiting for a task does not terminate that task.
- How to test shutdown order, timeout behavior, and repeated shutdown requests.

**Scope:** This lecture implements an isolated shutdown coordinator. It does not modify `src/workers.ts`, BullMQ workers, Redis configuration, PostgreSQL configuration, or your existing database migrations.

## 2. Why Graceful Shutdown Matters

Consider a worker that is processing jobs when the application receives a shutdown signal.

A dangerous shutdown looks like this:

```text
Shutdown signal
      |
      v
Close Redis and PostgreSQL immediately
      |
      v
Active job continues running
      |
      v
Job tries to use a closed connection
      |
      v
Job fails unexpectedly
```

A safer sequence is:

```text
Shutdown signal
      |
      v
Stop accepting new jobs
      |
      v
Signal active jobs to stop
      |
      v
Wait for active jobs, up to a deadline
      |
      +---- Jobs finish in time ----+
      |                             |
      v                             v
Close resources              Close resources
      |
      v
Shutdown complete
```

The application should attempt a controlled shutdown rather than immediately closing resources underneath active work.

However, graceful shutdown cannot guarantee that every task finishes. A task may hang, ignore cancellation, or be blocked by an external dependency.

That is why the shutdown deadline matters.

## 3. The Correct Shutdown Sequence

A typical worker shutdown has these stages:

1. **Stop accepting new work.** Prevent additional jobs from starting.
2. **Request cancellation.** Signal active jobs that they should stop.
3. **Wait for active work.** Allow cooperative jobs to finish within a configured timeout.
4. **Close resources.** Close worker connections, queues, database pools, and other resources in the correct application-specific order.
5. **Report the outcome.** Record whether the active work drained normally or the deadline expired.

This lecture implements the coordinator that orchestrates these stages.

It does not implement the underlying BullMQ or database shutdown operations. Those remain responsibilities of the actual application lifecycle.

## 4. Design Decisions

We will model three shutdown outcomes:

- `completed`: Active work finished before the deadline.
- `timed-out`: Active work did not finish before the deadline.
- `failed`: A shutdown operation failed.

The coordinator will enforce these rules:

- Shutdown operations execute in the required order.
- Repeated calls to `shutdown()` share the same promise.
- Active work is given a bounded amount of time to finish.
- Resources are closed even when draining times out or an earlier shutdown step fails.
- The result identifies whether the shutdown completed, timed out, or failed.

**Important limitation:** JavaScript cannot safely terminate an arbitrary promise. When the drain timeout expires, the coordinator proceeds with resource cleanup, but the original task may still be running. The task itself must support cancellation, and the application must account for work that outlives the shutdown deadline.

## 5. Project Scope and Folder Structure

Create these two files:

```text
src/
└── services/
    └── graceful-shutdown.coordinator.ts

tests/
└── graceful-shutdown.coordinator.test.ts
```

No database migration is needed.

Do not change:

- `src/workers.ts`
- `src/server.ts`
- Existing BullMQ workers
- Existing leader-election services
- `src/database/migrations/`
- Redis or PostgreSQL configuration

The coordinator is independent of your existing application startup code.

## 6. Implement the Shutdown Coordinator

### Step 1 — Create the service

**File: `src/services/graceful-shutdown.coordinator.ts`**

Create this file with the complete code below.

```typescript
export type ShutdownStatus =
  | "completed"
  | "timed-out"
  | "failed";

export interface ShutdownResult {
  status: ShutdownStatus;
  errors: unknown[];
}

export interface GracefulShutdownDependencies {
  stopAcceptingWork(): Promise<void>;
  cancelActiveWork(): Promise<void>;
  waitForActiveWork(): Promise<void>;
  closeResources(): Promise<void>;
}

export interface GracefulShutdownConfig {
  drainTimeoutMs: number;
}

export class GracefulShutdownCoordinator {
  private shutdownPromise:
    Promise<ShutdownResult> | null = null;

  constructor(
    private readonly dependencies:
      GracefulShutdownDependencies,
    private readonly config:
      GracefulShutdownConfig
  ) {
    if (
      !Number.isSafeInteger(config.drainTimeoutMs) ||
      config.drainTimeoutMs < 1
    ) {
      throw new Error(
        "drainTimeoutMs must be a positive safe integer"
      );
    }
  }

  shutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.runShutdown();

    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<ShutdownResult> {
    const errors: unknown[] = [];

    let status: ShutdownStatus = "completed";

    try {
      await this.dependencies.stopAcceptingWork();
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    try {
      await this.dependencies.cancelActiveWork();
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    try {
      const drained = await this.waitForDrain();

      if (!drained && status !== "failed") {
        status = "timed-out";
      }
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    try {
      await this.dependencies.closeResources();
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    return {
      status,
      errors
    };
  }

  private async waitForDrain(): Promise<boolean> {
    let timeoutId:
      ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(
        () => resolve(false),
        this.config.drainTimeoutMs
      );
    });

    try {
      return await Promise.race([
        this.dependencies
          .waitForActiveWork()
          .then(() => true),
        timeout
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}
```

### Step 2 — Understand the implementation

#### Idempotent shutdown request

```typescript
shutdown(): Promise<ShutdownResult> {
  if (this.shutdownPromise) {
    return this.shutdownPromise;
  }

  this.shutdownPromise = this.runShutdown();

  return this.shutdownPromise;
}
```

If two parts of the application call `shutdown()` at nearly the same time, the coordinator starts the sequence once and returns the same promise to both callers.

This prevents duplicate execution of the coordinator's shutdown steps.

It does not make the underlying cleanup functions idempotent by themselves; the coordinator ensures it invokes them only once through this shutdown path.

#### Stop accepting new work

```typescript
await this.dependencies.stopAcceptingWork();
```

This is the first step. The actual implementation might close a worker to new jobs, pause a queue consumer, or set an application-level stopping flag.

The exact action depends on the worker library and your application architecture.

#### Cancel active work

```typescript
await this.dependencies.cancelActiveWork();
```

This function should signal cancellation to tasks that support it. For example, it might abort a shared `AbortController` used by active tasks.

The function should not wait indefinitely for every task to finish. Waiting for completion belongs to the next stage.

#### Wait with a deadline

```typescript
return await Promise.race([
  this.dependencies
    .waitForActiveWork()
    .then(() => true),
  timeout
]);
```

The coordinator waits for either:

- The active work to finish, or
- The timeout to expire.

If the timeout wins, the coordinator continues to resource cleanup.

**`Promise.race()` does not cancel the losing promise.** If active work is still running after the timeout, it may continue in the background. This is why cancellation and fencing remain important.

#### Close resources

```typescript
await this.dependencies.closeResources();
```

This step is attempted even if stopping work, cancellation, or draining fails.

The function represents application-specific cleanup. In a real worker process, it may need to close several resources in a carefully defined order rather than using one generic callback.

## 7. Write the Unit Tests

### Step 1 — Create the test file

**File: `tests/graceful-shutdown.coordinator.test.ts`**

Create this file with the complete code below.

```typescript
import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  GracefulShutdownCoordinator,
  type GracefulShutdownDependencies
} from "../src/services/graceful-shutdown.coordinator.js";

const createDependencies = () => {
  const calls: string[] = [];

  const dependencies: GracefulShutdownDependencies = {
    stopAcceptingWork: vi.fn(async () => {
      calls.push("stop");
    }),

    cancelActiveWork: vi.fn(async () => {
      calls.push("cancel");
    }),

    waitForActiveWork: vi.fn(async () => {
      calls.push("drain");
    }),

    closeResources: vi.fn(async () => {
      calls.push("close");
    })
  };

  return {
    calls,
    dependencies
  };
};

describe("GracefulShutdownCoordinator", () => {
  it("runs shutdown steps in the required order", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result).toEqual({
      status: "completed",
      errors: []
    });

    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("runs shutdown only once for repeated calls", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();

    expect(first).toBe(second);

    const [firstResult, secondResult] =
      await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("reports a timeout when active work does not finish", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    dependencies.waitForActiveWork =
      vi.fn(() => new Promise<void>(() => {}));

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 10 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("timed-out");

    expect(calls).toEqual([
      "stop",
      "cancel",
      "close"
    ]);

    expect(
      dependencies.closeResources
    ).toHaveBeenCalledTimes(1);
  });

  it("closes resources if stopping new work fails", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    dependencies.stopAcceptingWork =
      vi.fn(async () => {
        calls.push("stop");
        throw new Error("Unable to stop consumer");
      });

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("failed");

    expect(result.errors).toHaveLength(1);

    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("closes resources if cancellation fails", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    dependencies.cancelActiveWork =
      vi.fn(async () => {
        calls.push("cancel");
        throw new Error("Cancellation failed");
      });

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("failed");
    expect(result.errors).toHaveLength(1);

    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("reports failure if resource cleanup fails", async () => {
    const {
      dependencies
    } = createDependencies();

    dependencies.closeResources =
      vi.fn(async () => {
        throw new Error("Resource cleanup failed");
      });

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("failed");
    expect(result.errors).toHaveLength(1);
  });

  it("rejects an invalid drain timeout", () => {
    const {
      dependencies
    } = createDependencies();

    expect(() =>
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 0 }
      )
    ).toThrow(
      "drainTimeoutMs must be a positive safe integer"
    );
  });
});
```

### Step 2 — Understand the tests

The tests cover:

- The order in which shutdown callbacks execute.
- Repeated shutdown calls.
- An active task that never finishes.
- Failure to stop accepting new work.
- Failure to signal cancellation.
- Failure during resource cleanup.
- Invalid timeout configuration.

The timeout test uses a promise that never settles. The coordinator must still reach `closeResources()` after the configured deadline.

## 8. Test the Shutdown Timeout

### Step 1 — Run the focused tests

From your project root, run:

```powershell
npm run test:run -- tests/graceful-shutdown.coordinator.test.ts
```

Expected result: all seven tests pass.

Do not assume the tests passed until you see the result.

### Step 2 — Observe the timeout behavior

In the timeout test, this promise never resolves:

```typescript
dependencies.waitForActiveWork =
  vi.fn(() => new Promise<void>(() => {}));
```

The coordinator's timeout wins the race. It then attempts resource cleanup and returns a `timed-out` result.

The unresolved promise remains unresolved. The coordinator has not forcibly stopped the underlying task.

This distinction is essential when designing shutdown behavior for real background workers.

## 9. Intentionally Break the Implementation

We will remove the timeout behavior temporarily.

### Step 1 — Break the timeout

**File: `src/services/graceful-shutdown.coordinator.ts`**

Inside `waitForDrain()`, find:

```typescript
return await Promise.race([
  this.dependencies
    .waitForActiveWork()
    .then(() => true),
  timeout
]);
```

Temporarily replace that return statement with:

```typescript
return await this.dependencies
  .waitForActiveWork()
  .then(() => true);
```

Keep the surrounding `try` and `finally` structure.

### Step 2 — Run only the timeout test

```powershell
npm run test:run -- tests/graceful-shutdown.coordinator.test.ts -t "reports a timeout"
```

The test should fail to finish within a reasonable period because `waitForActiveWork()` never settles.

Stop the test command if it remains stuck. Do not wait indefinitely.

### Step 3 — Restore the correct implementation

Restore:

```typescript
return await Promise.race([
  this.dependencies
    .waitForActiveWork()
    .then(() => true),
  timeout
]);
```

Run the focused tests again:

```powershell
npm run test:run -- tests/graceful-shutdown.coordinator.test.ts
```

Expected result: all seven tests pass.

Never leave the broken version in place.

## 10. Build and Verification

### Step 1 — Run the focused tests

```powershell
npm run test:run -- tests/graceful-shutdown.coordinator.test.ts
```

### Step 2 — Run the full test suite

```powershell
npm run test:run
```

Investigate any failures instead of assuming they are unrelated.

### Step 3 — Run the TypeScript build

```powershell
npm run build
```

Use the existing scripts in your `package.json`. Do not add or change package scripts solely for this exercise unless your project actually requires it.

## 11. Production Considerations

### 11.1 The timeout only bounds the wait

The coordinator bounds how long it waits for active work. It cannot guarantee that the underlying task has stopped.

If the task continues after timeout, closing its dependencies can cause errors. A production implementation must account for this explicitly.

Possible strategies include:

- Cooperative cancellation checks inside tasks.
- Per-job timeouts and retry policies.
- Fencing tokens for protected database writes.
- Idempotency keys for retryable side effects.
- A process-level termination deadline managed by the application runtime.

### 11.2 Do not close shared resources too early

A real application may have several resources:

- BullMQ workers.
- BullMQ queues and event listeners.
- Redis connections.
- PostgreSQL pools.
- HTTP servers.

Their shutdown order depends on which components depend on which resources. For example, closing a database pool before a job has finished using it may make that job fail.

The coordinator does not determine the correct order for your actual project. Its callbacks must be connected to verified lifecycle operations when integration is eventually appropriate.

### 11.3 Do not assume a timed-out job is safe to retry

A task may have completed an external side effect just before its local promise stalled or its process lost contact with the result.

Retrying without idempotency can duplicate the side effect.

The timeout tells us that the coordinator did not observe completion within the deadline. It does not prove that the task performed no work.

### 11.4 This is not wired into your application

The new class is independent. `src/workers.ts` remains unchanged.

We are not replacing your existing shutdown lifecycle with this coordinator until the actual worker and server lifecycle code has been verified.

## 12. Final Folder Structure

After this lecture, the relevant structure should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/                       # Existing; unchanged
│   │   └── pool.ts                           # Existing; unchanged
│   ├── services/
│   │   └── graceful-shutdown.coordinator.ts  # NEW
│   └── workers.ts                            # Unchanged
└── tests/
    └── graceful-shutdown.coordinator.test.ts # NEW
```

No SQL migration is required.

No existing worker or server file needs to be edited for this isolated exercise.

## 13. Success Criteria

- [ ] Created `src/services/graceful-shutdown.coordinator.ts`.
- [ ] Created `tests/graceful-shutdown.coordinator.test.ts`.
- [ ] All seven focused tests pass.
- [ ] Verified that shutdown callbacks execute in the required order.
- [ ] Verified that repeated shutdown calls share one promise.
- [ ] Verified that a hung drain does not block resource cleanup forever.
- [ ] Verified that cleanup is attempted when earlier steps fail.
- [ ] Restored the timeout implementation after the intentional break.
- [ ] Ran the full test suite and TypeScript build.
- [ ] Left `src/workers.ts` unchanged.
- [ ] Left `src/database/migrations/` unchanged.
- [ ] Understand that a timeout does not forcibly terminate a running task.

## 14. Next Lecture

**Module 3 — Lecture 15: Idempotency Under Retries and Concurrent Execution**

Next, we will study what happens when a job is retried after a timeout or uncertain failure. We will examine how duplicate requests arise, how an idempotency key identifies a logical operation, and why database constraints and transactions are necessary to enforce idempotency under concurrency.
