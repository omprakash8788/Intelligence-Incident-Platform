
# Module 3 — Lecture 9: Leader Runtime Integration, Fencing, and Failure Recovery

## Table of Contents

1. [Learning Objectives](#1-learning-objectives)
2. [Review of Lecture 8](#2-review-of-lecture-8)
3. [Understand the Integration Architecture](#3-understand-the-integration-architecture)
4. [Define the Lease Provider Adapter](#4-define-the-lease-provider-adapter)
5. [Implement the Adapter](#5-implement-the-adapter)
6. [Write Adapter Unit Tests](#6-write-adapter-unit-tests)
7. [Understand Leadership Loss](#7-understand-leadership-loss)
8. [Protect Writes with Fencing Tokens](#8-protect-writes-with-fencing-tokens)
9. [Failure Recovery Scenarios](#9-failure-recovery-scenarios)
10. [Build and Test](#10-build-and-test)
11. [Break the Code Intentionally](#11-break-the-code-intentionally)
12. [Production Integration Checklist](#12-production-integration-checklist)
13. [Final Project Structure](#13-final-project-structure)
14. [Success Criteria](#14-success-criteria)

---

## 1. Learning Objectives

In Lecture 8, we created a leader-runtime controller that manages acquisition, renewal, leadership loss, and shutdown.

Now we need to connect the runtime's generic lease interface to the existing PostgreSQL-backed leader-election service.

By the end of this lecture, you will understand:

- Why a lease-provider adapter separates application lifecycle from database operations.
- How to prevent the runtime from depending directly on PostgreSQL implementation details.
- Why leadership loss must stop leader-only work.
- Why a lease alone cannot stop an old process from writing.
- How fencing tokens protect a resource from stale leaders.
- How to test adapters without connecting to PostgreSQL.
- How to plan a safe integration with the existing worker lifecycle.

Our workflow remains:

**Build → Test → Break intentionally → Understand failure → Fix → Verify**

### Important scope

This lecture introduces an adapter contract and its unit tests. Your existing `leader-election.service.ts` implementation and `src/workers.ts` lifecycle must be checked before connecting them.

Do not replace existing services or migrations based on assumed function signatures. The adapter contract below is complete and testable independently; the final wiring depends on the actual types in your project.

---

## 2. Review of Lecture 8

Our runtime accepts a lease provider with three operations:

```ts
export interface LeaseProvider<Lease> {
  acquire(): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
}
```

The runtime does not need to know how a lease is stored.

It only needs to know how to:

1. Acquire leadership.
2. Renew the current lease.
3. Release the lease during shutdown.

The existing PostgreSQL service provides the database-backed operations. An adapter translates between the service API and the runtime API.

### Architecture

```text
src/workers.ts
     |
     v
LeaderRuntime
     |
     v
LeaseProvider Adapter
     |
     v
leader-election.service.ts
     |
     v
PostgreSQL
```

This separation allows us to test the runtime independently of the database.

---

## 3. Understand the Integration Architecture

Suppose your existing service exposes operations similar to:

```ts
acquireLeadership(electionName, leaderId, leaseMs);
renewLeadership(lease, leaseMs);
releaseLeadership(lease);
```

The adapter must translate these operations into the generic interface used by `LeaderRuntime`.

However, the actual lease type and exact parameter types must come from your existing service. Do not invent a lease interface that conflicts with your implementation.

### Why use an adapter?

Without an adapter, the runtime might import the database service directly:

```ts
// Avoid coupling the runtime directly to database functions.
import {
  acquireLeadership,
  renewLeadership,
  releaseLeadership
} from "./leader-election.service.js";
```

That makes the runtime harder to test and ties its implementation to a specific service API.

With an adapter, the runtime depends on an interface rather than a concrete database implementation.

### Responsibilities

| Component | Responsibility |
|---|---|
| Leader runtime | Lifecycle, renewal attempts, leadership transitions |
| Lease provider | Translate acquire, renew, and release operations |
| Leader-election service | Perform authoritative lease operations |
| PostgreSQL | Store and validate lease ownership |
| Protected resource | Reject stale fencing tokens |

The adapter must not pretend that a timed-out renewal failed definitively. The runtime should conservatively stop leader-only work when ownership cannot be confirmed.

---

## 4. Define the Lease Provider Adapter

### 4.1 Create the adapter contract

**File:** `src/services/leader-lease-provider.types.ts`

**Action:** Create this new file.

```ts
export interface LeaseProvider<Lease> {
  acquire(): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
}

export interface LeaderLeaseService<Lease> {
  acquireLeadership(
    electionName: string,
    leaderId: string,
    leaseMs: number
  ): Promise<Lease | null>;

  renewLeadership(
    lease: Lease,
    leaseMs: number
  ): Promise<Lease | null>;

  releaseLeadership(
    lease: Lease
  ): Promise<boolean>;
}

export interface LeaderLeaseProviderConfig {
  electionName: string;
  leaderId: string;
  leaseMs: number;
}

export interface LeaderLeaseProviderDependencies<Lease> {
  service: LeaderLeaseService<Lease>;
  config: LeaderLeaseProviderConfig;
}
```

### 4.2 Understand the contract

`LeaderLeaseService<Lease>` describes the expected shape of the service API.

`LeaseProvider<Lease>` describes what the runtime requires.

The provider will bridge these two interfaces.

**Integration warning:** The method signatures above reflect the service shape introduced in the earlier lectures. If your actual `leader-election.service.ts` uses a different return type or parameter order, adjust the contract to match the existing service. Do not change a working database service merely to fit this example.

---

## 5. Implement the Adapter

### 5.1 Create the adapter implementation

**File:** `src/services/leader-lease-provider.service.ts`

**Action:** Create this new file.

```ts
import type {
  LeaderLeaseProviderDependencies,
  LeaseProvider
} from "./leader-lease-provider.types.js";

import type {
  LeaderLeaseService
} from "./leader-lease-provider.types.js";

import type {
  LeaderLeaseProviderConfig
} from "./leader-lease-provider.types.js";

export class LeaderLeaseProvider<Lease>
  implements LeaseProvider<Lease>
{
  private readonly service: LeaderLeaseService<Lease>;
  private readonly config: LeaderLeaseProviderConfig;

  constructor(
    dependencies: LeaderLeaseProviderDependencies<Lease>
  ) {
    this.service = dependencies.service;
    this.config = dependencies.config;

    this.validateConfig(this.config);
  }

  async acquire(): Promise<Lease | null> {
    return this.service.acquireLeadership(
      this.config.electionName,
      this.config.leaderId,
      this.config.leaseMs
    );
  }

  async renew(lease: Lease): Promise<Lease | null> {
    return this.service.renewLeadership(
      lease,
      this.config.leaseMs
    );
  }

  async release(lease: Lease): Promise<boolean> {
    return this.service.releaseLeadership(lease);
  }

  private validateConfig(
    config: LeaderLeaseProviderConfig
  ): void {
    if (
      config.electionName.trim().length === 0
    ) {
      throw new Error(
        "electionName must not be empty"
      );
    }

    if (
      config.leaderId.trim().length === 0
    ) {
      throw new Error(
        "leaderId must not be empty"
      );
    }

    if (
      !Number.isSafeInteger(config.leaseMs) ||
      config.leaseMs <= 0
    ) {
      throw new Error(
        "leaseMs must be a positive safe integer"
      );
    }
  }
}
```

### 5.2 Understand the adapter

The adapter performs three translations:

- `acquire()` forwards the election name, process identity, and lease duration.
- `renew(lease)` forwards the lease and the configured duration.
- `release(lease)` forwards the lease to the service.

It does not:

- Create a PostgreSQL pool.
- Open a Redis connection.
- Start timers.
- Decide whether a lease is valid independently.
- Generate fencing tokens locally.
- Swallow service errors.

The database service remains responsible for authoritative lease operations.

### 5.3 Why errors propagate

If PostgreSQL is unavailable, the service might reject a renewal promise.

The adapter propagates that rejection so the runtime can stop leader-only activity.

Returning a fake successful lease would be unsafe because it would make the runtime believe ownership had been confirmed when it had not.

---

## 6. Write Adapter Unit Tests

### 6.1 Create the test file

**File:** `tests/leader-lease-provider.service.test.ts`

**Action:** Create this new file.

```ts
import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  LeaderLeaseProvider
} from "../src/services/leader-lease-provider.service.js";

import type {
  LeaderLeaseService
} from "../src/services/leader-lease-provider.types.js";

interface TestLease {
  electionName: string;
  leaderId: string;
  fencingToken: string;
}

function createTestService() {
  const lease: TestLease = {
    electionName: "incident-scheduler",
    leaderId: "worker-a",
    fencingToken: "10"
  };

  const service: LeaderLeaseService<TestLease> = {
    acquireLeadership: vi.fn().mockResolvedValue(
      lease
    ),

    renewLeadership: vi.fn().mockResolvedValue(
      lease
    ),

    releaseLeadership: vi.fn().mockResolvedValue(
      true
    )
  };

  return {
    lease,
    service
  };
}

describe("LeaderLeaseProvider", () => {
  it("rejects an empty election name", () => {
    const { service } = createTestService();

    expect(
      () =>
        new LeaderLeaseProvider({
          service,
          config: {
            electionName: " ",
            leaderId: "worker-a",
            leaseMs: 15_000
          }
        })
    ).toThrow(
      "electionName must not be empty"
    );
  });

  it("rejects an empty leader ID", () => {
    const { service } = createTestService();

    expect(
      () =>
        new LeaderLeaseProvider({
          service,
          config: {
            electionName: "incident-scheduler",
            leaderId: " ",
            leaseMs: 15_000
          }
        })
    ).toThrow(
      "leaderId must not be empty"
    );
  });

  it("rejects a non-positive lease duration", () => {
    const { service } = createTestService();

    expect(
      () =>
        new LeaderLeaseProvider({
          service,
          config: {
            electionName: "incident-scheduler",
            leaderId: "worker-a",
            leaseMs: 0
          }
        })
    ).toThrow(
      "leaseMs must be a positive safe integer"
    );
  });

  it("forwards acquisition arguments", async () => {
    const { lease, service } = createTestService();

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(provider.acquire()).resolves.toEqual(
      lease
    );

    expect(
      service.acquireLeadership
    ).toHaveBeenCalledWith(
      "incident-scheduler",
      "worker-a",
      15_000
    );
  });

  it("forwards the lease during renewal", async () => {
    const { lease, service } = createTestService();

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(
      provider.renew(lease)
    ).resolves.toEqual(lease);

    expect(
      service.renewLeadership
    ).toHaveBeenCalledWith(
      lease,
      15_000
    );
  });

  it("forwards the lease during release", async () => {
    const { lease, service } = createTestService();

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(
      provider.release(lease)
    ).resolves.toBe(true);

    expect(
      service.releaseLeadership
    ).toHaveBeenCalledWith(lease);
  });

  it("propagates acquisition failures", async () => {
    const { service } = createTestService();

    vi.mocked(service.acquireLeadership)
      .mockRejectedValueOnce(
        new Error("Database unavailable")
      );

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(
      provider.acquire()
    ).rejects.toThrow("Database unavailable");
  });
});
```

### 6.2 What these tests prove

The tests verify:

- Invalid configuration is rejected.
- The adapter forwards the correct arguments.
- The adapter preserves the service's lease result.
- Service failures propagate to the caller.

These are unit tests with a mock service. They do not prove that the PostgreSQL lease SQL is correct or that multiple processes coordinate safely.

---

## 7. Understand Leadership Loss

A leader runtime must stop initiating leader-only work when renewal fails or ownership becomes uncertain.

Consider this sequence:

```text
Worker A acquires lease
        |
        v
Worker A starts singleton task
        |
        v
Renewal request fails
        |
        v
Worker A stops initiating leader-only work
        |
        v
Worker B acquires leadership
```

The old worker might still have asynchronous operations in progress. Changing a runtime state cannot forcibly cancel arbitrary JavaScript promises.

### 7.1 Design cancellation into leader-only tasks

A leader-only task that supports cancellation can accept an `AbortSignal`.

Example contract:

```ts
export interface LeaderTask {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}
```

The task should check the signal before initiating new work and pass cancellation to downstream APIs where supported.

Do not assume every database query or external request can be cancelled simply because the signal was aborted.

### 7.2 Do not stop every BullMQ worker

Leadership is usually needed for genuinely singleton activities, such as:

- A singleton scheduler.
- A periodic coordinator.
- A leader-only reconciliation process.
- A single-owner control loop.

Ordinary BullMQ workers can usually run on multiple application instances. They should not all be disabled merely because one process is not the leader.

---

## 8. Protect Writes with Fencing Tokens

A lease says who should own a resource now. A fencing token helps a resource reject operations from an older owner.

Suppose:

```text
Worker A gets token 10
Worker A pauses
Lease expires
Worker B gets token 11
Worker B writes successfully
Worker A resumes and attempts a write with token 10
```

The protected resource must reject Worker A's stale write.

### 8.1 Why a random UUID is not enough

A UUID can identify a worker or operation, but it does not establish ordering.

Fencing tokens need an ordering property:

```text
10 < 11 < 12 < 13
```

The resource should accept a new operation only when the token is newer than the last accepted token, subject to the application's transaction and idempotency rules.

### 8.2 Use the existing fencing-token service

Earlier lectures introduced `src/services/fencing-token.service.ts`.

Do not create a second fencing-token generator for the leader runtime.

Before wiring fencing into a real business operation, verify that:

1. The token is allocated by the authoritative mechanism.
2. The token is associated with the correct resource or leadership tenure.
3. The protected resource stores the last accepted token.
4. The resource rejects stale tokens transactionally.
5. The operation is idempotent where retries can occur.

### 8.3 Important limitation

A fencing token only protects resources that actually enforce it. A token stored in the leader lease table does not magically stop stale code from writing to another database table or external service.

---

## 9. Failure Recovery Scenarios

| Scenario | Required behavior |
|---|---|
| Acquisition returns `null` | Remain a follower and retry according to policy |
| Acquisition throws | Report the error and do not assume leadership |
| Renewal returns `null` | Stop leader-only activity and transition out of leader state |
| Renewal times out | Treat ownership as uncertain and stop initiating leader-only work |
| Release fails during shutdown | Report the failure; let the lease expire naturally |
| Old leader resumes | Protected resources must reject stale fencing tokens |
| Process receives shutdown signal | Stop the runtime and its leader-only tasks in lifecycle order |

### Recovery principle

**Never restore leadership merely because a retry timer fired.**

Leadership must be established by a successful authoritative acquisition or renewal operation.

A production runtime should also use bounded requests, backoff, jitter, and explicit metrics. Those are part of the full lifecycle integration and should be verified against the actual project.

---

## 10. Build and Test

Run these commands in PowerShell from the project root.

### 10.1 Run the adapter tests

```powershell
npm run test:run -- tests/leader-lease-provider.service.test.ts
```

Expected: seven tests pass.

### 10.2 Run the runtime tests

```powershell
npm run test:run -- tests/leader-runtime.service.test.ts
```

Expected: all five runtime tests pass, including the corrected renewal-failure test.

### 10.3 Run the state-machine tests

```powershell
npm run test:run -- tests/leader-runtime.policy.test.ts
```

Expected: all six state-machine tests pass.

### 10.4 Build the application

```powershell
npm run build
```

Expected: TypeScript compilation succeeds.

### 10.5 Run the complete test suite

```powershell
npm run test:run
```

Expected: all existing and new tests pass.

If TypeScript reports that the actual leader-election service does not match `LeaderLeaseService<Lease>`, inspect its real signatures and adapt the contract. Do not silence the error with `any` or replace the existing service.

---

## 11. Break the Code Intentionally

### Break A: Pass an empty election name

**File:** `tests/leader-lease-provider.service.test.ts`

Temporarily change a valid configuration to:

```ts
config: {
  electionName: " ",
  leaderId: "worker-a",
  leaseMs: 15_000
}
```

Run:

```powershell
npm run test:run -- tests/leader-lease-provider.service.test.ts
```

The constructor should throw:

```text
electionName must not be empty
```

Restore the valid configuration in any test where you changed it.

### Break B: Make acquisition fail

The test already demonstrates this failure mode:

```ts
vi.mocked(service.acquireLeadership)
  .mockRejectedValueOnce(
    new Error("Database unavailable")
  );
```

Run the adapter tests and confirm that the error propagates.

The adapter must not turn a rejected promise into a fake successful lease.

### Fix and verify

```powershell
npm run test:run -- tests/leader-lease-provider.service.test.ts
npm run test:run -- tests/leader-runtime.policy.test.ts
npm run test:run -- tests/leader-runtime.service.test.ts
npm run test:run
npm run build
```

Do not proceed until the tests and build pass.

---

## 12. Production Integration Checklist

Before connecting the adapter to `src/workers.ts`, inspect the actual project files.

```text
src/services/leader-election.service.ts
src/services/leader-runtime.service.ts
src/services/leader-runtime.policy.ts
src/workers.ts
src/server/shutdown.ts
src/database/pool.ts
src/services/fencing-token.service.ts
```

Verify all of the following:

- [ ] The existing service signatures match the adapter contract.
- [ ] The lease type contains the information needed for safe renewal and release.
- [ ] The application uses one shared PostgreSQL pool.
- [ ] Acquisition and renewal requests have bounded timeouts.
- [ ] Renewal failure stops leader-only work.
- [ ] Leadership loss is handled only once per leadership tenure.
- [ ] Shutdown stops the runtime before closing resources it depends on.
- [ ] Fencing tokens are enforced by the protected resource.
- [ ] The runtime does not unnecessarily disable ordinary BullMQ workers.
- [ ] Integration tests cover competing processes and lease expiration.

This lecture does not modify `src/workers.ts`, because its exact current contents and the actual leader-service signatures must be checked before safe integration. The adapter and tests are independent additions; they are not proof that the runtime has been wired into the application.

---

## 13. Final Project Structure

The new files introduced by this lecture are:

```text
production-intelligence-platform/
├── src/
│   └── services/
│       ├── leader-election.service.ts
│       ├── leader-runtime.policy.ts
│       ├── leader-runtime.service.ts
│       ├── leader-lease-provider.types.ts       # NEW
│       └── leader-lease-provider.service.ts     # NEW
└── tests/
    ├── leader-runtime.policy.test.ts
    ├── leader-runtime.service.test.ts
    └── leader-lease-provider.service.test.ts    # NEW
```

Preserve all other project files, migrations, and worker registrations.

---

## 14. Success Criteria

- [ ] Created the lease-provider contract.
- [ ] Created the lease-provider adapter.
- [ ] Added seven adapter unit tests.
- [ ] Adapter tests pass.
- [ ] Leader-runtime tests pass.
- [ ] State-machine tests pass.
- [ ] The full test suite passes.
- [ ] TypeScript compilation succeeds.
- [ ] Understand why a lease alone cannot stop an old process from writing.
- [ ] Understand how fencing tokens reject stale operations.
- [ ] Verified the real service interface before attempting integration.
- [ ] Have not created a duplicate database pool or replaced existing migrations.

---

## Next Lecture

**Module 3 — Lecture 10: Distributed Locks, Fencing, and Concurrent Failure Testing**

We will test the coordination guarantees more deeply, examine competing workers, and design integration tests that expose stale-owner and concurrent-acquisition failures.
