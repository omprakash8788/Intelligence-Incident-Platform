
# Module 3 — Lecture 8: Building a Safe Leader Runtime

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [What We Built in Previous Lectures](#2-what-we-built-in-previous-lectures)
3. [Why a Leader-Election Service Is Not Enough](#3-why-a-leader-election-service-is-not-enough)
4. [Designing the Leader Runtime](#4-designing-the-leader-runtime)
5. [Defining the Runtime State Machine](#5-defining-the-runtime-state-machine)
6. [Creating the Runtime Policy](#6-creating-the-runtime-policy)
7. [Creating the Leader Runtime](#7-creating-the-leader-runtime)
8. [Writing Unit Tests](#8-writing-unit-tests)
9. [Integrating with the Existing Application](#9-integrating-with-the-existing-application)
10. [Build and Verification](#10-build-and-verification)
11. [Break the Runtime Intentionally](#11-break-the-runtime-intentionally)
12. [Production Safety Considerations](#12-production-safety-considerations)
13. [Final Project Structure](#13-final-project-structure)
14. [Success Criteria](#14-success-criteria)

---

## 1. Learning Objectives

In Lecture 6, we built a PostgreSQL-backed leader-election service.

In Lecture 7, we learned about clock drift, lease timing, timeouts, and the limits of local timers.

Now we will study how an application should manage the lifecycle of a leader.

By the end, you should understand:

- Why leader election and leader execution are different responsibilities.
- How to represent leadership using explicit states.
- Why a failed or ambiguous renewal must stop leader-only work.
- How to start, stop, and clean up a leader runtime.
- How to prevent overlapping renewal attempts.
- How to make shutdown idempotent.
- How to test the runtime without connecting to PostgreSQL.
- Why lease ownership and fencing must still be enforced by the protected resource.

### Workflow

**Build → Test → Break intentionally → Understand failure → Fix → Verify**

### Scope

This lecture implements a reusable, dependency-injected runtime controller. It does not automatically connect to your production worker lifecycle because the exact current lifecycle and exported worker names must be verified before wiring it into `src/workers.ts`.

We will keep the runtime independent of a particular database client and avoid creating another PostgreSQL connection pool.

---

## 2. What We Built in Previous Lectures

Our distributed-systems learning path now includes:

| Lecture | Topic |
|---|---|
| 1 | At-least-once vs exactly-once processing |
| 2 | Distributed locks |
| 3 | Locks applied to BullMQ workers |
| 4 | Redlock quorum and validity |
| 5 | Lease expiration and fencing tokens |
| 6 | PostgreSQL-backed leader election |
| 7 | Clock drift, timeouts, and lease safety |
| 8 | Safe leader runtime |

The existing leader-election service was designed around functions similar to:

```ts
acquireLeadership(electionName, leaderId, leaseMs)
renewLeadership(lease, leaseMs)
releaseLeadership(lease)
```

The service is responsible for database operations. The runtime is responsible for coordinating those operations over time.

**Important:** Keep your actual `leader-election.service.ts` implementation and its migration intact. Do not replace an applied migration or create a second database pool for this lecture.

---

## 3. Why a Leader-Election Service Is Not Enough

Consider a worker that acquires leadership successfully.

```text
Application starts
       |
       v
Acquire lease
       |
       v
Lease acquired
       |
       v
Perform leader-only work
```

What happens next?

- The lease eventually expires.
- The worker needs to renew it.
- The database may become unavailable.
- A renewal may time out.
- Another process may become leader.
- The application may receive a shutdown signal.
- The worker may need to stop accepting new work.

Without a runtime controller, these responsibilities are easy to implement inconsistently.

### A dangerous implementation

```ts
let isLeader = false;

setInterval(async () => {
  const lease = await renewLeadership(/* ... */);

  if (lease) {
    isLeader = true;
  }
}, 5000);
```

This approach has several problems:

1. `setInterval` can start a new renewal while the previous renewal is still running.
2. A rejected promise can become an unhandled rejection.
3. The code does not define what happens after a renewal failure.
4. The application may continue leader-only work after losing leadership.
5. Shutdown does not necessarily stop the timer.
6. A local boolean is not proof of current ownership.

We need a controlled lifecycle with explicit states and a single renewal loop.

---

## 4. Designing the Leader Runtime

We will separate the runtime into two responsibilities.

### Lease provider

The lease provider performs the actual lease operations.

It must be implemented using the existing PostgreSQL service.

```ts
interface LeaseProvider<Lease> {
  acquire(): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
}
```

The runtime does not need to know whether the lease is stored in PostgreSQL or another supported coordination system.

### Leader hooks

Leader hooks define what the application should do when it gains or loses leadership.

```ts
interface LeaderHooks {
  onLeadershipAcquired(): Promise<void>;
  onLeadershipLost(): Promise<void>;
}
```

For example:

- `onLeadershipAcquired()` could start a singleton scheduler.
- `onLeadershipLost()` could stop that scheduler and prevent new leader-only operations.

Do not automatically start all BullMQ workers when leadership is acquired. Ordinary distributed job workers can often run concurrently, while only selected singleton tasks need leadership.

### Runtime state

We will use these states:

| State | Meaning |
|---|---|
| `stopped` | Runtime is not running |
| `acquiring` | Trying to acquire leadership |
| `leader` | Leadership is currently confirmed |
| `follower` | Running but does not hold leadership |
| `stopping` | Shutdown is in progress |

A failed or ambiguous renewal must transition the runtime out of `leader`.

---

## 5. Defining the Runtime State Machine

The main lifecycle is:

```text
                 start()
                    |
                    v
                acquiring
               /         \
       acquired           not acquired
           |                    |
           v                    v
         leader              follower
           |                    |
     renew succeeds       retry acquisition
           |
           v
         leader

Leader renewal failure
           |
           v
       follower

Any active state
           |
        stop()
           |
           v
        stopping
           |
           v
         stopped
```

The state machine prevents the runtime from treating leadership as a permanent boolean.

### Important safety rule

A transition to `follower` means the runtime must no longer initiate leader-only work.

Stopping existing asynchronous work may require cancellation support in that work itself. The runtime cannot forcibly terminate arbitrary JavaScript promises.

---

## 6. Creating the Runtime Policy

### 6.1 Create the runtime policy

**File:** `src/services/leader-runtime.policy.ts`

**Action:** Create this new file.

```ts
export type LeaderRuntimeState =
  | "stopped"
  | "acquiring"
  | "leader"
  | "follower"
  | "stopping";

export type LeaderRuntimeEvent =
  | "START"
  | "ACQUIRE_SUCCEEDED"
  | "ACQUIRE_FAILED"
  | "RENEW_SUCCEEDED"
  | "RENEW_FAILED"
  | "STOP";

const transitions: Record<
  LeaderRuntimeState,
  Partial<Record<LeaderRuntimeEvent, LeaderRuntimeState>>
> = {
  stopped: {
    START: "acquiring"
  },

  acquiring: {
    ACQUIRE_SUCCEEDED: "leader",
    ACQUIRE_FAILED: "follower",
    STOP: "stopping"
  },

  leader: {
    RENEW_SUCCEEDED: "leader",
    RENEW_FAILED: "follower",
    STOP: "stopping"
  },

  follower: {
    ACQUIRE_SUCCEEDED: "leader",
    ACQUIRE_FAILED: "follower",
    STOP: "stopping"
  },

  stopping: {
    STOP: "stopped"
  }
};

export function transitionLeaderRuntime(
  state: LeaderRuntimeState,
  event: LeaderRuntimeEvent
): LeaderRuntimeState {
  const nextState = transitions[state][event];

  if (!nextState) {
    throw new Error(
      `Invalid leader runtime transition: ${state} + ${event}`
    );
  }

  return nextState;
}
```

### 6.2 Why use a pure transition function?

This function does not:

- Connect to PostgreSQL.
- Start timers.
- Change global state.
- Start or stop workers.

It only decides whether a state transition is valid.

That makes it straightforward to test.

---

## 7. Creating the Leader Runtime

The runtime below uses dependency injection. It receives a lease provider and hooks instead of importing a concrete database pool.

The implementation uses a single asynchronous loop rather than overlapping `setInterval` callbacks.

It also uses `AbortController` so shutdown can interrupt retry delays. Lease-provider operations themselves must have bounded request timeouts; aborting the loop does not magically cancel a database request.

### 7.1 Create the runtime implementation

**File:** `src/services/leader-runtime.service.ts`

**Action:** Create this new file.

```ts
import {
  transitionLeaderRuntime,
  type LeaderRuntimeState
} from "./leader-runtime.policy.js";

export interface LeaseProvider<Lease> {
  acquire(): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
}

export interface LeaderHooks {
  onLeadershipAcquired(): Promise<void>;
  onLeadershipLost(): Promise<void>;
}

export interface LeaderRuntimeConfig {
  retryIntervalMs: number;
}

export interface LeaderRuntimeDependencies<Lease> {
  leaseProvider: LeaseProvider<Lease>;
  hooks: LeaderHooks;
  config: LeaderRuntimeConfig;
  onError?: (error: unknown) => void;
}

function validateConfig(
  config: LeaderRuntimeConfig
): void {
  if (
    !Number.isSafeInteger(config.retryIntervalMs) ||
    config.retryIntervalMs <= 0
  ) {
    throw new Error(
      "retryIntervalMs must be a positive safe integer"
    );
  }
}

function sleep(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, {
      once: true
    });
  });
}

export class LeaderRuntime<Lease> {
  private state: LeaderRuntimeState = "stopped";
  private currentLease: Lease | null = null;
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private hooksStarted = false;

  constructor(
    private readonly dependencies:
      LeaderRuntimeDependencies<Lease>
  ) {
    validateConfig(dependencies.config);
  }

  getState(): LeaderRuntimeState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(
        `Cannot start leader runtime from state: ${this.state}`
      );
    }

    this.state = transitionLeaderRuntime(
      this.state,
      "START"
    );

    this.controller = new AbortController();

    this.loopPromise = this.runLoop(
      this.controller.signal
    );

    // Wait until the first acquisition attempt completes.
    // This makes the initial state observable to the caller.
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.performStop();

    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }

    if (this.state !== "stopping") {
      this.state = transitionLeaderRuntime(
        this.state,
        "STOP"
      );
    }

    this.controller?.abort();

    const loop = this.loopPromise;

    if (loop) {
      await loop;
    }

    // Release only after the renewal/acquisition loop has ended.
    const lease = this.currentLease;

    this.currentLease = null;

    if (lease !== null) {
      try {
        await this.dependencies.leaseProvider.release(
          lease
        );
      } catch (error) {
        this.reportError(error);
      }
    }

    if (this.hooksStarted) {
      this.hooksStarted = false;

      try {
        await this.dependencies.hooks
          .onLeadershipLost();
      } catch (error) {
        this.reportError(error);
      }
    }

    this.state = transitionLeaderRuntime(
      this.state,
      "STOP"
    );
  }

  private async runLoop(
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      if (this.currentLease === null) {
        await this.tryAcquire(signal);
      } else {
        await this.tryRenew(signal);
      }

      if (signal.aborted) {
        break;
      }

      await sleep(
        this.dependencies.config.retryIntervalMs,
        signal
      );
    }
  }

  private async tryAcquire(
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }

    try {
      const lease =
        await this.dependencies.leaseProvider.acquire();

      if (signal.aborted) {
        if (lease !== null) {
          try {
            await this.dependencies.leaseProvider
              .release(lease);
          } catch (error) {
            this.reportError(error);
          }
        }

        return;
      }

      if (lease === null) {
        this.state = transitionLeaderRuntime(
          this.state,
          "ACQUIRE_FAILED"
        );

        return;
      }

      this.currentLease = lease;

      this.state = transitionLeaderRuntime(
        this.state,
        "ACQUIRE_SUCCEEDED"
      );

      await this.dependencies.hooks
        .onLeadershipAcquired();

      this.hooksStarted = true;
    } catch (error) {
      this.reportError(error);

      if (this.state === "acquiring") {
        this.state = transitionLeaderRuntime(
          this.state,
          "ACQUIRE_FAILED"
        );
      } else if (this.state === "leader") {
        await this.loseLeadership();
      }
    }
  }

  private async tryRenew(
    signal: AbortSignal
  ): Promise<void> {
    const lease = this.currentLease;

    if (lease === null || signal.aborted) {
      return;
    }

    try {
      const renewedLease =
        await this.dependencies.leaseProvider
          .renew(lease);

      if (signal.aborted) {
        return;
      }

      if (renewedLease === null) {
        await this.loseLeadership();
        return;
      }

      this.currentLease = renewedLease;

      this.state = transitionLeaderRuntime(
        this.state,
        "RENEW_SUCCEEDED"
      );
    } catch (error) {
      this.reportError(error);
      await this.loseLeadership();
    }
  }

  private async loseLeadership(): Promise<void> {
    this.currentLease = null;

    if (this.state === "leader") {
      this.state = transitionLeaderRuntime(
        this.state,
        "RENEW_FAILED"
      );
    }

    if (this.hooksStarted) {
      this.hooksStarted = false;

      try {
        await this.dependencies.hooks
          .onLeadershipLost();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.dependencies.onError?.(error);
    } catch {
      // Error reporting must not crash the runtime loop.
    }
  }
}
```

### 7.2 Understand the important behavior

The runtime:

- Acquires a lease when starting.
- Calls the acquisition hook after obtaining a lease.
- Attempts renewal in a single loop.
- Stops treating itself as leader after renewal failure.
- Calls the loss hook when leadership is lost.
- Releases a known lease during shutdown.
- Makes repeated `stop()` calls share the same shutdown promise.
- Uses injected dependencies, so unit tests do not need PostgreSQL.

### Important implementation limitations

This is an educational runtime controller, not yet a complete production integration.

Before production use, it needs further hardening:

1. The acquisition and renewal operations must have explicit, bounded timeouts.
2. Shutdown must account for an in-flight database request that may not be cancellable.
3. The lease provider must use the existing authoritative PostgreSQL lease service.
4. Leader-only tasks need cancellation and must not continue unprotected after lease loss.
5. Protected writes must enforce fencing tokens where stale owners are dangerous.
6. Production retry policy should include backoff and jitter.
7. Metrics and health reporting should expose leadership transitions and renewal failures.
8. The runtime should be integration-tested against the real database and process lifecycle.

**Do not wire this into the main application yet if your existing lease-service signature or worker lifecycle differs from the assumptions here.** Verify the interfaces and tests first.

---

## 8. Writing Unit Tests

### 8.1 Test the state machine

**File:** `tests/leader-runtime.policy.test.ts`

**Action:** Create this new file.

```ts
import { describe, expect, it } from "vitest";

import {
  transitionLeaderRuntime
} from "../src/services/leader-runtime.policy.js";

describe("transitionLeaderRuntime", () => {
  it("starts in acquiring state", () => {
    expect(
      transitionLeaderRuntime("stopped", "START")
    ).toBe("acquiring");
  });

  it("transitions to leader after acquisition", () => {
    expect(
      transitionLeaderRuntime(
        "acquiring",
        "ACQUIRE_SUCCEEDED"
      )
    ).toBe("leader");
  });

  it("transitions to follower after acquisition failure", () => {
    expect(
      transitionLeaderRuntime(
        "acquiring",
        "ACQUIRE_FAILED"
      )
    ).toBe("follower");
  });

  it("loses leadership after renewal failure", () => {
    expect(
      transitionLeaderRuntime(
        "leader",
        "RENEW_FAILED"
      )
    ).toBe("follower");
  });

  it("remains leader after successful renewal", () => {
    expect(
      transitionLeaderRuntime(
        "leader",
        "RENEW_SUCCEEDED"
      )
    ).toBe("leader");
  });

  it("rejects invalid transitions", () => {
    expect(() =>
      transitionLeaderRuntime(
        "stopped",
        "RENEW_SUCCEEDED"
      )
    ).toThrow(
      "Invalid leader runtime transition"
    );
  });
});
```

### 8.2 Test the runtime lifecycle

**File:** `tests/leader-runtime.service.test.ts`

**Action:** Create this new file.

```ts
import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  LeaderRuntime,
  type LeaderHooks,
  type LeaseProvider
} from "../src/services/leader-runtime.service.js";

interface TestLease {
  leaderId: string;
  fencingToken: string;
}

function createDependencies() {
  const lease: TestLease = {
    leaderId: "worker-a",
    fencingToken: "1"
  };

  const leaseProvider: LeaseProvider<TestLease> = {
    acquire: vi.fn().mockResolvedValue(lease),
    renew: vi.fn().mockResolvedValue(lease),
    release: vi.fn().mockResolvedValue(true)
  };

  const hooks: LeaderHooks = {
    onLeadershipAcquired: vi.fn().mockResolvedValue(
      undefined
    ),
    onLeadershipLost: vi.fn().mockResolvedValue(
      undefined
    )
  };

  return {
    lease,
    leaseProvider,
    hooks
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LeaderRuntime", () => {
  it("rejects an invalid retry interval", () => {
    const dependencies = createDependencies();

    expect(
      () =>
        new LeaderRuntime({
          ...dependencies,
          config: {
            retryIntervalMs: 0
          }
        })
    ).toThrow(
      "retryIntervalMs must be a positive safe integer"
    );
  });

  it("acquires leadership and calls the acquisition hook", async () => {
    const dependencies = createDependencies();

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 10_000
      }
    });

    await runtime.start();

    // Allow the asynchronous loop to perform acquisition.
    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("leader");
    });

    expect(
      dependencies.leaseProvider.acquire
    ).toHaveBeenCalledTimes(1);

    expect(
      dependencies.hooks.onLeadershipAcquired
    ).toHaveBeenCalledTimes(1);

    await runtime.stop();

    expect(runtime.getState()).toBe("stopped");
  });

  it("moves to follower when renewal fails", async () => {
    const dependencies = createDependencies();

    dependencies.leaseProvider.renew =
      vi.fn().mockResolvedValue(null);

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 5
      }
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("follower");
    });

    expect(
      dependencies.hooks.onLeadershipLost
    ).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it("releases the lease during shutdown", async () => {
    const dependencies = createDependencies();

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 10_000
      }
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("leader");
    });

    await runtime.stop();

    expect(
      dependencies.leaseProvider.release
    ).toHaveBeenCalledWith(dependencies.lease);

    expect(runtime.getState()).toBe("stopped");
  });

  it("makes repeated stop calls safe", async () => {
    const dependencies = createDependencies();

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 10_000
      }
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("leader");
    });

    await Promise.all([
      runtime.stop(),
      runtime.stop()
    ]);

    expect(runtime.getState()).toBe("stopped");

    expect(
      dependencies.leaseProvider.release
    ).toHaveBeenCalledTimes(1);
  });
});
```

### Testing note

These tests use mocked dependencies. They test runtime behavior, not PostgreSQL concurrency or the correctness of the actual database lease.

The asynchronous loop and shutdown behavior should be verified carefully. If a test exposes a race, fix the implementation rather than weakening the assertion.

---

## 9. Integrating with the Existing Application

This lecture deliberately stops before modifying `src/workers.ts`.

Your existing worker entry point already manages startup, readiness, cleanup, and shutdown for BullMQ workers and queue resources. A leader runtime must be added to that lifecycle in the correct order.

Before integration, inspect these files:

```text
src/services/leader-election.service.ts
src/workers.ts
src/server/shutdown.ts
src/database/pool.ts
```

Confirm:

- The actual exported names and parameter types of `acquireLeadership`, `renewLeadership`, and `releaseLeadership`.
- Whether the lease object contains the election name, leader ID, and fencing token.
- How the existing application registers shutdown handlers.
- Which tasks genuinely require singleton leadership.
- How the PostgreSQL pool is closed.

Do not create a second PostgreSQL pool. Do not close the shared pool from the runtime if other application components still depend on it.

### Integration order

When the interfaces have been verified, the intended lifecycle is:

1. Construct the lease provider using the existing leader-election service.
2. Construct the runtime with a unique process identity.
3. Start the runtime at the correct point in worker startup.
4. Start singleton leader-only tasks from the acquisition hook.
5. Stop accepting leader-only work in the loss hook.
6. Stop the runtime during shutdown.
7. Close the shared database pool only after all users of it have stopped.

A process identity should distinguish application instances. A fencing token should come from the authoritative coordination mechanism—not from a random UUID or a local counter.

Do not assume every BullMQ worker needs a leader lease. Distributed queues are designed to support multiple workers, while a singleton scheduler or periodic coordinator may need exclusive leadership.

---

## 10. Build and Verification

Run these commands from the project root in PowerShell.

### 10.1 Run the policy tests

```powershell
npm run test:run -- tests/leader-runtime.policy.test.ts
```

Expected: all six state-machine tests pass.

### 10.2 Run the runtime tests

```powershell
npm run test:run -- tests/leader-runtime.service.test.ts
```

Expected: all five runtime tests pass.

### 10.3 Build the application

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

### 10.4 Run the complete suite

```powershell
npm run test:run
```

Expected: all existing tests and the new tests pass.

If the test runner exposes an asynchronous shutdown race, investigate it. Do not assume that mocked tests prove safe behavior against a real PostgreSQL server.

---

## 11. Break the Runtime Intentionally

### Break A: Use an invalid retry interval

**File:** `tests/leader-runtime.service.test.ts`

Temporarily change:

```ts
retryIntervalMs: 10_000
```

to:

```ts
retryIntervalMs: 0
```

Run:

```powershell
npm run test:run -- tests/leader-runtime.service.test.ts
```

Expected: the configuration-validation test rejects the zero interval.

Restore the original valid value for the affected runtime tests.

### Break B: Simulate a failed renewal

In the runtime test, configure the provider to return `null` from `renew()`:

```ts
dependencies.leaseProvider.renew =
  vi.fn().mockResolvedValue(null);
```

The expected behavior is that the runtime transitions from `leader` to `follower` and calls `onLeadershipLost()`.

If the runtime remains in `leader`, the state transition is unsafe.

### Fix and verify

Run:

```powershell
npm run test:run -- tests/leader-runtime.policy.test.ts
npm run test:run -- tests/leader-runtime.service.test.ts
npm run test:run
npm run build
```

Do not integrate the runtime into the main worker lifecycle until these tests pass and the actual lease-provider interface has been verified.

---

## 12. Production Safety Considerations

This runtime is a foundation, not a complete production leader system.

### Renewal timeouts

The lease provider must enforce a bounded timeout. Otherwise, an in-flight request may prevent the runtime loop or shutdown from completing.

### Leadership loss

When leadership is lost, the runtime should stop initiating leader-only work immediately. Any already-running work must either be cancelled, made safe to finish, or protected by fencing at the destination.

### Fencing

A stale worker can continue executing after its lease expires. A protected database table or downstream service must reject writes carrying a fencing token older than the last accepted token.

### Retry policy

A production runtime should use backoff and jitter where appropriate to avoid all application instances repeatedly attempting acquisition at the same time.

### Observability

Useful metrics and logs include:

- Current leader-runtime state.
- Lease acquisition successes and failures.
- Renewal latency.
- Renewal timeout count.
- Leadership transitions.
- Lease-release failures.
- Time spent without a confirmed leader.

Never log secrets or credentials.

### Shutdown

Shutdown should be idempotent and coordinated with the application's existing worker lifecycle. Avoid closing shared database resources before the runtime has finished using them.

---

## 13. Final Project Structure

The new files introduced in this lecture are:

```text
production-intelligence-platform/
├── src/
│   └── services/
│       ├── leader-election.service.ts
│       ├── lease-timing.policy.ts
│       ├── leader-runtime.policy.ts       # NEW
│       └── leader-runtime.service.ts      # NEW
└── tests/
    ├── leader-election.service.test.ts
    ├── lease-timing.policy.test.ts
    ├── leader-runtime.policy.test.ts      # NEW
    └── leader-runtime.service.test.ts     # NEW
```

The tree shows only the files relevant to this lecture. Preserve the rest of the existing project.

---

## 14. Success Criteria

- [ ] Created the leader-runtime state policy.
- [ ] Created the dependency-injected runtime service.
- [ ] Added six state-machine tests.
- [ ] Added five runtime lifecycle tests.
- [ ] Verified failed renewal transitions the runtime to follower.
- [ ] Verified shutdown releases a known lease.
- [ ] Verified repeated shutdown calls do not release the lease twice.
- [ ] Focused tests pass.
- [ ] Full test suite passes.
- [ ] TypeScript build succeeds.
- [ ] You understand why a local leader state is not enough to protect writes.
- [ ] You have not wired the runtime into the main worker lifecycle without checking the actual service interfaces.

---

## Next Lecture

**Module 3 — Lecture 9: Leader Runtime Integration, Fencing, and Failure Recovery**

We will verify the existing project interfaces and integrate leadership with the real worker lifecycle, including controlled startup, renewal failure, graceful shutdown, and protection against stale leaders.
