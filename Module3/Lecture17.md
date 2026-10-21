
# Module 3 — Distributed Systems
# Lecture 17: Saga Pattern and Distributed Compensation

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [Why Distributed Transactions Are Difficult](#2-why-distributed-transactions-are-difficult)
3. [What Is the Saga Pattern?](#3-what-is-the-saga-pattern)
4. [Forward Actions and Compensating Actions](#4-forward-actions-and-compensating-actions)
5. [Design Our Saga](#5-design-our-saga)
6. [Project Scope and File Structure](#6-project-scope-and-file-structure)
7. [Implement the Saga Orchestrator](#7-implement-the-saga-orchestrator)
8. [Write the Unit Tests](#8-write-the-unit-tests)
9. [Test Failure and Compensation](#9-test-failure-and-compensation)
10. [Intentionally Break the Implementation](#10-intentionally-break-the-implementation)
11. [Build and Verification](#11-build-and-verification)
12. [Production Considerations](#12-production-considerations)
13. [Final Folder Structure](#13-final-folder-structure)
14. [Success Criteria](#14-success-criteria)
15. [Next Lecture](#15-next-lecture)

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a PostgreSQL transaction cannot atomically commit changes across independent services.
- How the Saga pattern coordinates a multi-step business workflow.
- The difference between a forward action and a compensating action.
- Why compensation usually runs in reverse order.
- How to handle a failed step and failed compensation separately.
- Why compensating actions must be designed for retries.
- How to test saga behavior without connecting it to production workers.

**Scope:** We will implement an isolated, in-memory saga orchestrator and unit tests. No database migration is needed for this exercise. We will not modify `src/workers.ts`, `src/server.ts`, or any existing database files.

## 2. Why Distributed Transactions Are Difficult

Imagine an e-commerce order that requires three operations:

1. Reserve inventory.
2. Charge the customer.
3. Arrange shipment.

Each operation may belong to a different service or system.

A PostgreSQL transaction can roll back changes made inside that PostgreSQL transaction. It cannot automatically reverse a payment that an external payment provider has already completed or cancel a shipment already accepted by another system.

### The failure scenario

```text
Create order
    |
    v
Reserve inventory ------ SUCCESS
    |
    v
Charge customer -------- SUCCESS
    |
    v
Arrange shipment ------- FAILURE
    |
    v
What should happen?
```

The workflow is now partially complete:

- Inventory is reserved.
- The customer has been charged.
- Shipment has not been arranged.

Simply throwing an exception does not undo the first two operations.

The system needs a business-level recovery strategy.

## 3. What Is the Saga Pattern?

A **saga** is a sequence of business steps. Each successful step may have a corresponding compensating action.

If a later step fails, the orchestrator attempts to compensate for the earlier completed steps.

For our order example:

| Forward action | Compensating action |
|---|---|
| Reserve inventory | Release the reservation |
| Charge customer | Refund the charge |
| Arrange shipment | Cancel the shipment, if cancellation is still possible |

The flow is:

```text
Reserve inventory
        |
        v
Charge customer
        |
        v
Arrange shipment
        |
        v
If successful: saga completes

If shipment fails:
        |
        v
Refund customer
        |
        v
Release inventory
        |
        v
Report the failed saga
```

Compensation runs in reverse order because later operations may depend on earlier operations.

### Saga orchestration vs. choreography

There are two common ways to coordinate a saga.

**Orchestration:** A central coordinator tells each step when to execute and when compensation is required.

**Choreography:** Services react to events and independently trigger the next actions.

In this lecture, we implement orchestration because the control flow is explicit and easier to test.

## 4. Forward Actions and Compensating Actions

A saga step contains two functions:

- `execute`: performs the forward business operation.
- `compensate`: attempts to reverse or counteract that operation.

Example:

```typescript
{
  name: "reserve-inventory",
  execute: reserveInventory,
  compensate: releaseInventory
}
```

### Important: compensation is not a database rollback

A refund is not the same as erasing the original payment transaction. It is a new business operation that counteracts the original charge.

Likewise, releasing inventory does not erase the historical fact that a reservation was made.

Compensation can fail. It can also be impossible if the external operation has passed an irreversible point.

A production saga therefore needs to record its state and provide a recovery mechanism for failed compensations.

## 5. Design Our Saga

We will build a generic orchestrator with the following behavior.

### Successful execution

1. Execute step A.
2. Execute step B.
3. Execute step C.
4. Return a successful result.

### Failed execution

1. Execute step A.
2. Execute step B.
3. Step C fails.
4. Compensate step B.
5. Compensate step A.
6. Return a failure result containing the original error and any compensation errors.

The orchestrator will compensate only steps whose `execute` function completed successfully.

**Important limitation:** If a step performs an external side effect and then throws before returning, the orchestrator cannot know whether that side effect occurred. Each step must handle ambiguous outcomes safely, or expose enough durable state to determine whether compensation is necessary.

## 6. Project Scope and File Structure

Create these two files:

```text
src/
└── services/
    └── saga-orchestrator.ts

tests/
└── saga-orchestrator.test.ts
```

No SQL migration is required.

Do not change:

- `src/workers.ts`
- `src/server.ts`
- `src/database/pool.ts`
- `src/database/migrations/`
- Existing BullMQ queues
- Existing leader-election services
- Existing idempotency or outbox services

This is a standalone learning component. It is not connected to your order processing or background job system.

## 7. Implement the Saga Orchestrator

### Step 1 — Create the service file

**File: `src/services/saga-orchestrator.ts`**

Create this file with the complete code below.

```typescript
export interface SagaStep<Context> {
  name: string;

  execute(
    context: Context
  ): Promise<void>;

  compensate(
    context: Context
  ): Promise<void>;
}

export type SagaStatus =
  | "completed"
  | "failed"
  | "compensation-failed";

export interface SagaCompensationFailure {
  stepName: string;
  error: unknown;
}

export interface SagaResult {
  status: SagaStatus;
  completedSteps: string[];
  compensatedSteps: string[];
  failedStep: string | null;
  error: unknown | null;
  compensationFailures: SagaCompensationFailure[];
}

export class SagaOrchestrator<Context> {
  constructor(
    private readonly steps: SagaStep<Context>[]
  ) {
    const names = new Set<string>();

    for (const step of steps) {
      if (step.name.trim().length === 0) {
        throw new Error(
          "Saga step name must not be empty"
        );
      }

      if (names.has(step.name)) {
        throw new Error(
          `Duplicate saga step name: ${step.name}`
        );
      }

      names.add(step.name);
    }
  }

  async execute(
    context: Context
  ): Promise<SagaResult> {
    const completed: SagaStep<Context>[] = [];
    const completedSteps: string[] = [];
    const compensatedSteps: string[] = [];
    const compensationFailures:
      SagaCompensationFailure[] = [];

    let failedStep: string | null = null;
    let originalError: unknown | null = null;

    for (const step of this.steps) {
      try {
        await step.execute(context);

        completed.push(step);
        completedSteps.push(step.name);
      } catch (error) {
        failedStep = step.name;
        originalError = error;

        break;
      }
    }

    if (originalError === null) {
      return {
        status: "completed",
        completedSteps,
        compensatedSteps,
        failedStep: null,
        error: null,
        compensationFailures
      };
    }

    for (
      let index = completed.length - 1;
      index >= 0;
      index -= 1
    ) {
      const step = completed[index];

      try {
        await step.compensate(context);

        compensatedSteps.push(step.name);
      } catch (error) {
        compensationFailures.push({
          stepName: step.name,
          error
        });
      }
    }

    return {
      status:
        compensationFailures.length > 0
          ? "compensation-failed"
          : "failed",

      completedSteps,
      compensatedSteps,
      failedStep,
      error: originalError,
      compensationFailures
    };
  }
}
```

### Step 2 — Understand the types

#### `SagaStep`

```typescript
export interface SagaStep<Context> {
  name: string;

  execute(context: Context): Promise<void>;

  compensate(context: Context): Promise<void>;
}
```

Every step receives the same context object.

The context can contain identifiers and information needed by the forward and compensating operations.

In a production implementation, avoid storing credentials or unnecessary sensitive information in a saga context.

#### `SagaResult`

The result tells us:

- Whether the saga completed or failed.
- Which forward steps completed.
- Which compensations completed.
- Which forward step failed.
- The original failure.
- Which compensations failed.

This is useful for testing and for understanding what happened during an execution.

It is not yet a durable audit record. The result exists only in application memory.

### Step 3 — Why record a step only after it succeeds?

The orchestrator does this:

```typescript
await step.execute(context);

completed.push(step);
completedSteps.push(step.name);
```

If `execute()` rejects, the step is not added to the completed list.

The orchestrator therefore compensates previously completed steps only.

However, this assumes that a rejected operation did not leave an untracked side effect. Real external operations may have ambiguous outcomes, which must be handled separately.

### Step 4 — Why compensate in reverse order?

The loop begins with the last completed step:

```typescript
for (
  let index = completed.length - 1;
  index >= 0;
  index -= 1
) {
  const step = completed[index];
}
```

If the completed steps are A, B, and C, compensation runs:

```text
C -> B -> A
```

The failed step is not automatically compensated because the orchestrator does not know whether it performed its side effect.

### Step 5 — Why continue if compensation fails?

Suppose compensation for B fails. The orchestrator should still attempt compensation for A.

Otherwise, one failed compensation would prevent every earlier completed step from being considered for recovery.

The result becomes `compensation-failed` if any compensation fails.

## 8. Write the Unit Tests

### Step 1 — Create the test file

**File: `tests/saga-orchestrator.test.ts`**

Create this file with the complete code below.

```typescript
import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  SagaOrchestrator,
  type SagaStep
} from "../src/services/saga-orchestrator.js";

interface OrderContext {
  orderId: string;
  events: string[];
}

const createContext = (): OrderContext => ({
  orderId: "order-100",
  events: []
});

describe("SagaOrchestrator", () => {
  it("executes every step when all steps succeed", async () => {
    const context = createContext();

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async (ctx) => {
          ctx.events.push("reserve");
        },

        compensate: async (ctx) => {
          ctx.events.push("release");
        }
      },
      {
        name: "charge-customer",

        execute: async (ctx) => {
          ctx.events.push("charge");
        },

        compensate: async (ctx) => {
          ctx.events.push("refund");
        }
      },
      {
        name: "arrange-shipment",

        execute: async (ctx) => {
          ctx.events.push("ship");
        },

        compensate: async (ctx) => {
          ctx.events.push("cancel-shipment");
        }
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe("completed");

    expect(result.completedSteps).toEqual([
      "reserve-inventory",
      "charge-customer",
      "arrange-shipment"
    ]);

    expect(result.compensatedSteps).toEqual([]);
    expect(result.failedStep).toBeNull();
    expect(result.error).toBeNull();

    expect(context.events).toEqual([
      "reserve",
      "charge",
      "ship"
    ]);
  });

  it("compensates completed steps in reverse order", async () => {
    const context = createContext();

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async (ctx) => {
          ctx.events.push("reserve");
        },

        compensate: async (ctx) => {
          ctx.events.push("release");
        }
      },
      {
        name: "charge-customer",

        execute: async (ctx) => {
          ctx.events.push("charge");
        },

        compensate: async (ctx) => {
          ctx.events.push("refund");
        }
      },
      {
        name: "arrange-shipment",

        execute: async () => {
          throw new Error(
            "Shipment service unavailable"
          );
        },

        compensate: async (ctx) => {
          ctx.events.push("cancel-shipment");
        }
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe("failed");

    expect(result.completedSteps).toEqual([
      "reserve-inventory",
      "charge-customer"
    ]);

    expect(result.compensatedSteps).toEqual([
      "charge-customer",
      "reserve-inventory"
    ]);

    expect(result.failedStep).toBe(
      "arrange-shipment"
    );

    expect(result.error).toEqual(
      new Error("Shipment service unavailable")
    );

    expect(context.events).toEqual([
      "reserve",
      "charge",
      "refund",
      "release"
    ]);
  });

  it("continues compensating if one compensation fails", async () => {
    const context = createContext();

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async (ctx) => {
          ctx.events.push("reserve");
        },

        compensate: async (ctx) => {
          ctx.events.push("release");
        }
      },
      {
        name: "charge-customer",

        execute: async (ctx) => {
          ctx.events.push("charge");
        },

        compensate: async () => {
          throw new Error("Refund service unavailable");
        }
      },
      {
        name: "arrange-shipment",

        execute: async () => {
          throw new Error("Shipment failed");
        },

        compensate: async () => {}
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe(
      "compensation-failed"
    );

    expect(result.compensatedSteps).toEqual([
      "reserve-inventory"
    ]);

    expect(result.compensationFailures).toHaveLength(1);

    expect(
      result.compensationFailures[0].stepName
    ).toBe("charge-customer");

    expect(context.events).toEqual([
      "reserve",
      "charge",
      "release"
    ]);
  });

  it("does not execute later steps after a failure", async () => {
    const context = createContext();

    const laterExecute = vi.fn(
      async () => undefined
    );

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async () => {
          throw new Error("Inventory unavailable");
        },

        compensate: async () => {}
      },
      {
        name: "charge-customer",

        execute: laterExecute,

        compensate: async () => {}
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe("failed");

    expect(result.completedSteps).toEqual([]);

    expect(result.compensatedSteps).toEqual([]);

    expect(result.failedStep).toBe(
      "reserve-inventory"
    );

    expect(laterExecute).not.toHaveBeenCalled();
  });

  it("rejects duplicate step names", () => {
    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve",

        execute: async () => {},

        compensate: async () => {}
      },
      {
        name: "reserve",

        execute: async () => {},

        compensate: async () => {}
      }
    ];

    expect(() => {
      new SagaOrchestrator(steps);
    }).toThrow("Duplicate saga step name: reserve");
  });

  it("rejects an empty step name", () => {
    const steps: SagaStep<OrderContext>[] = [
      {
        name: " ",

        execute: async () => {},

        compensate: async () => {}
      }
    ];

    expect(() => {
      new SagaOrchestrator(steps);
    }).toThrow("Saga step name must not be empty");
  });

  it("does not compensate a step whose execution failed", async () => {
    const compensate = vi.fn(
      async () => undefined
    );

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async () => {
          throw new Error("Reservation failed");
        },

        compensate
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(
      createContext()
    );

    expect(result.status).toBe("failed");

    expect(compensate).not.toHaveBeenCalled();
  });
});
```

### Step 2 — Understand the test coverage

The seven tests cover:

1. Successful execution.
2. Reverse-order compensation.
3. Compensation failure while continuing earlier compensations.
4. Stopping forward execution after failure.
5. Duplicate step-name validation.
6. Empty step-name validation.
7. Not compensating a step whose execution did not complete successfully.

The tests use an in-memory context to verify the orchestration logic. They do not contact PostgreSQL, Redis, payment providers, or shipping services.

## 9. Test Failure and Compensation

Let's walk through the main failure test.

The forward execution is:

```text
reserve-inventory -> SUCCESS
charge-customer   -> SUCCESS
arrange-shipment  -> FAILURE
```

The compensation sequence becomes:

```text
refund customer
      |
      v
release inventory
```

The result should report:

```text
status = failed

completedSteps:
- reserve-inventory
- charge-customer

compensatedSteps:
- charge-customer
- reserve-inventory

failedStep:
- arrange-shipment
```

If refunding fails, the orchestrator should still attempt to release inventory. The overall status then becomes `compensation-failed`.

This distinction is important:

- `failed`: The forward workflow failed, and all attempted compensations succeeded.
- `compensation-failed`: The forward workflow failed, and at least one compensation also failed.

Neither result guarantees that the business process has been fully restored. The result is an execution report that a production recovery mechanism must persist and act upon.

## 10. Intentionally Break the Implementation

We will break the compensation order and verify that the tests detect it.

### Step 1 — Modify the compensation loop

**File: `src/services/saga-orchestrator.ts`**

Find this loop:

```typescript
for (
  let index = completed.length - 1;
  index >= 0;
  index -= 1
) {
```

Temporarily replace it with:

```typescript
for (
  let index = 0;
  index < completed.length;
  index += 1
) {
```

This changes compensation from reverse order to forward order.

### Step 2 — Run the focused tests

From your project root, run:

```powershell
npm run test:run -- tests/saga-orchestrator.test.ts
```

The reverse-order compensation test should fail because the expected order is:

```text
charge-customer
reserve-inventory
```

The broken implementation will attempt:

```text
reserve-inventory
charge-customer
```

### Step 3 — Restore the correct implementation

Restore the original loop:

```typescript
for (
  let index = completed.length - 1;
  index >= 0;
  index -= 1
) {
```

Run the tests again:

```powershell
npm run test:run -- tests/saga-orchestrator.test.ts
```

Expected result: all seven tests pass.

Do not leave the broken loop in your code.

## 11. Build and Verification

### Step 1 — Run the focused tests

```powershell
npm run test:run -- tests/saga-orchestrator.test.ts
```

### Step 2 — Run the complete test suite

```powershell
npm run test:run
```

Investigate any failures rather than assuming they are unrelated.

### Step 3 — Run the TypeScript build

```powershell
npm run build
```

If the build fails, inspect the exact TypeScript error and match the code to your existing project conventions.

Do not modify `src/workers.ts`, your database pool, or migrations to fix an unrelated error.

Do not claim the tests or build passed until you have run them and seen the result.

## 12. Production Considerations

### 12.1 Compensation is a new operation

A refund is not a deletion of the original charge. It is a separate transaction that can succeed, fail, or time out.

Compensating actions need their own error handling and observability.

### 12.2 Compensation must be retryable

Suppose the refund succeeds but the orchestrator crashes before recording success.

On recovery, the system may attempt the refund again.

A production refund operation should use a stable idempotency key or another mechanism that prevents duplicate refunds.

The same principle applies to releasing inventory or cancelling a shipment.

### 12.3 A failed step can have an ambiguous outcome

An external service might complete an operation but return a timeout to the caller.

The orchestrator may interpret the step as failed even though the side effect occurred.

For example:

```text
Payment provider processes charge
          |
          v
Response is lost
          |
          v
Saga sees a timeout
```

The orchestrator must not blindly assume that no charge occurred. It may need to query the provider using an operation identifier before deciding whether to retry or compensate.

### 12.4 Compensation is not always possible

A shipment may already have left the warehouse. A notification may already have been delivered. A payment may require a delayed refund.

Some workflows require a different recovery action rather than a literal reversal.

The business domain must define what compensation means for each step.

### 12.5 This orchestrator is not durable

The current implementation stores its progress in local variables.

If the Node.js process crashes, the list of completed steps and compensation progress disappears.

A production saga generally needs durable state, such as a PostgreSQL saga record with:

- A stable saga ID.
- Current state.
- Completed steps.
- Pending compensation actions.
- Retry counts.
- Last errors.
- Timestamps and recovery metadata.

That durable orchestration state is beyond this lecture's isolated implementation.

### 12.6 Do not confuse a saga with a distributed transaction

A saga coordinates multiple local transactions and business-level compensations. It does not provide one atomic transaction spanning every service.

Other services may temporarily observe intermediate states. The workflow must be designed to tolerate those states.

### 12.7 No production integration has been performed

This orchestrator is independent of your existing workers and queue system.

Do not import it into `src/workers.ts` yet. Before integration, we need to decide how saga state is persisted, how each step is made idempotent, and how recovery resumes after a process crash.

## 13. Final Folder Structure

After this lecture, the relevant structure should look like this:

```text
production-intelligence-platform/
├── src/
│   ├── database/
│   │   ├── migrations/                    # Existing; unchanged
│   │   └── pool.ts                        # Existing; unchanged
│   ├── services/
│   │   └── saga-orchestrator.ts           # NEW
│   └── workers.ts                         # Unchanged
└── tests/
    └── saga-orchestrator.test.ts          # NEW
```

No SQL migration is required for this in-memory learning exercise.

## 14. Success Criteria

- [ ] Created `src/services/saga-orchestrator.ts`.
- [ ] Created `tests/saga-orchestrator.test.ts`.
- [ ] All seven focused tests pass.
- [ ] Verified forward steps execute in sequence.
- [ ] Verified compensation runs in reverse order.
- [ ] Verified later forward steps do not run after a failure.
- [ ] Verified earlier compensations continue even if one compensation fails.
- [ ] Verified the original failure is retained in the result.
- [ ] Restored the correct loop after the intentional break.
- [ ] Ran the full test suite and TypeScript build.
- [ ] Left `src/workers.ts` unchanged.
- [ ] Understand that this orchestrator is not durable and is not production-ready without persistent recovery state.

## 15. Next Lecture

**Module 3 — Lecture 18: Failure Recovery and Crash-Window Analysis**

Next, we will analyze the moments when a process can crash between a business action, a state update, and a retry. We will map the crash windows, identify which outcomes are known or ambiguous, and design recovery rules around idempotency, fencing, and the transactional outbox.
