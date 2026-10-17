
# Module 3 — Lecture 2: Distributed Locks

## Table of Contents

1. Learning objectives
2. Why distributed locks are necessary
3. How Redis locks work
4. Build the lock service
5. Test the implementation
6. Verify the lock in Redis
7. Break it intentionally
8. Fix and verify
9. Production considerations
10. Final checklist

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a JavaScript boolean or mutex cannot coordinate separate Node.js processes.
- How Redis `SET ... NX PX` acquires a lock atomically.
- Why every lock needs a unique ownership token.
- Why deleting a lock without checking ownership is dangerous.
- How Lua scripts make lock release atomic.
- How TTL helps recover when a process crashes.
- Why a Redis lock alone does not guarantee exactly-once execution or complete distributed-system safety.

### Prerequisites

Complete Module 3, Lecture 1 and verify that your existing project builds successfully before adding this lecture.

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Open PowerShell in that directory.

---

## 2. Why Do We Need Distributed Locks?

Imagine that two API requests try to generate the same report simultaneously.

```text
Request A ──> Node.js Process A ──┐
                                  ├──> Shared report resource
Request B ──> Node.js Process B ──┘
```

Both processes might start the report generation at the same time.

A local JavaScript lock cannot prevent this because each process has its own memory.

### Incorrect approach: a local boolean

File: `src/services/local-lock.example.ts`

Create this file only if you want to experiment with the intentionally incorrect example.

```ts
let isLocked = false;

export async function doWork(): Promise<void> {
  if (isLocked) {
    throw new Error("Already locked");
  }

  isLocked = true;

  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
  } finally {
    isLocked = false;
  }
}
```

This protects only callers that share the same module instance in the same process.

If you start two Node.js processes, each has its own `isLocked` variable.

**Conclusion:** Multiple processes need a shared coordination mechanism.

---

## 3. How a Redis Distributed Lock Works

Redis supports an atomic lock-acquisition command:

```redis
SET lock:report:1001 <unique-token> NX PX 10000
```

Meaning:

| Part | Purpose |
|---|---|
| `lock:report:1001` | Shared lock key |
| Unique token | Identifies the lock owner |
| `NX` | Set the key only if it does not already exist |
| `PX 10000` | Expire the lock after 10,000 milliseconds |

If the key does not exist, Redis creates it and returns `OK`.

If another owner already holds the lock, Redis returns `null`.

The acquisition is atomic: two clients cannot both successfully create the same key using this command at the same time.

### Why do we need a unique token?

Suppose Process A acquires the lock. Its lease expires, and Process B acquires the same lock.

If Process A later tries to release the lock, it must not delete Process B's lock.

Therefore, releasing a lock must check that the stored token still matches the owner's token.

---

## 4. Build the Distributed Lock Service

We will use your existing Redis client. **Do not create another Redis connection for this lecture.**

Before proceeding, open:

`src/redis/client.ts`

Find the existing exported ioredis client. The code below assumes that it is exported as `redis`. If your file uses another export name, change only the import identifier to match your existing client. Do not replace your Redis configuration or lifecycle management.

### 4.1 Create the service

File: `src/services/distributed-lock.service.ts`

Action: Create this file. If this file already exists from earlier work, compare it with the implementation below and avoid overwriting working changes blindly.

```ts
import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";

const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export class DistributedLockService {
  async acquire(
    resource: string,
    ttlMs: number
  ): Promise<string | null> {
    if (!resource.trim()) {
      throw new Error("Lock resource is required");
    }

    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Lock TTL must be a positive integer");
    }

    const key = `lock:${resource}`;
    const token = randomUUID();

    const result = await redis.set(
      key,
      token,
      "PX",
      ttlMs,
      "NX"
    );

    if (result !== "OK") {
      return null;
    }

    return token;
  }

  async release(
    resource: string,
    token: string
  ): Promise<boolean> {
    if (!resource.trim() || !token.trim()) {
      throw new Error("Lock resource and token are required");
    }

    const key = `lock:${resource}`;

    const result = await redis.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      key,
      token
    );

    return result === 1;
  }
}

export const distributedLockService =
  new DistributedLockService();
```

### 4.2 Understand the important parts

**Lock acquisition**

```ts
const result = await redis.set(
  key,
  token,
  "PX",
  ttlMs,
  "NX"
);
```

Redis atomically creates the lock only when no lock exists.

**Safe release**

```ts
const result = await redis.eval(
  RELEASE_LOCK_SCRIPT,
  1,
  key,
  token
);
```

The Lua script compares the stored token and deletes the key only when the tokens match. Redis executes the script atomically.

**Why not use `DEL` directly?**

An unconditional deletion can remove a lock that now belongs to another process.

**Why use a TTL?**

If a process crashes without releasing its lock, the key eventually expires instead of remaining forever.

---

## 5. Test the Implementation

We will test lock acquisition, contention, ownership, and expiration using a mocked Redis client. These are unit tests; Redis integration will be verified separately.

### 5.1 Create the test

File: `tests/distributed-lock.service.test.ts`

Action: Create this test file.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    set: vi.fn(),
    eval: vi.fn()
  }
}));

vi.mock("../src/redis/client.js", () => ({
  redis: redisMock
}));

import { DistributedLockService } from
  "../src/services/distributed-lock.service.js";

describe("DistributedLockService", () => {
  let service: DistributedLockService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DistributedLockService();
  });

  it("returns a token when acquisition succeeds", async () => {
    redisMock.set.mockResolvedValue("OK");

    const token = await service.acquire("report:1001", 10_000);

    expect(token).toEqual(expect.any(String));
    expect(redisMock.set).toHaveBeenCalledWith(
      "lock:report:1001",
      token,
      "PX",
      10_000,
      "NX"
    );
  });

  it("returns null when another owner holds the lock", async () => {
    redisMock.set.mockResolvedValue(null);

    const token = await service.acquire("report:1001", 10_000);

    expect(token).toBeNull();
  });

  it("rejects an empty resource", async () => {
    await expect(service.acquire(" ", 10_000))
      .rejects.toThrow("Lock resource is required");

    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("rejects an invalid TTL", async () => {
    await expect(service.acquire("report:1001", 0))
      .rejects.toThrow("Lock TTL must be a positive integer");
  });

  it("releases a lock when the owner token matches", async () => {
    redisMock.eval.mockResolvedValue(1);

    await expect(
      service.release("report:1001", "owner-token")
    ).resolves.toBe(true);

    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1])'),
      1,
      "lock:report:1001",
      "owner-token"
    );
  });

  it("does not release a lock owned by someone else", async () => {
    redisMock.eval.mockResolvedValue(0);

    await expect(
      service.release("report:1001", "wrong-token")
    ).resolves.toBe(false);
  });

  it("rejects release with a missing token", async () => {
    await expect(service.release("report:1001", " "))
      .rejects.toThrow("Lock resource and token are required");

    expect(redisMock.eval).not.toHaveBeenCalled();
  });
});
```

### 5.2 Run the test

PowerShell — project root:

```powershell
npm run test:run -- tests/distributed-lock.service.test.ts
```

Expected result: all seven tests pass.

Then build the application:

```powershell
npm run build
```

If the import of `redis` fails, inspect `src/redis/client.ts` and use its actual exported client name. Do not create a second Redis client just to fix the import.

---

## 6. Verify the Lock in Real Redis

Unit tests use a mock. Now verify the underlying Redis behavior with your running Redis service.

### 6.1 Acquire the lock

PowerShell — project root:

```powershell
docker compose exec redis redis-cli SET lock:account:1001 test-token NX PX 10000
```

If your Compose service is not named `redis`, substitute its actual service name.

Expected output:

```text
OK
```

### 6.2 Try acquiring the same lock again

```powershell
docker compose exec redis redis-cli SET lock:account:1001 another-token NX PX 10000
```

Expected output:

```text
(nil)
```

```
PS D:\Production-Intelligence-Incident-Platform\production-intelligence-platform> docker compose exec redis redis-cli DEL lock:account:1001
(integer) 0
PS D:\Production-Intelligence-Incident-Platform\production-intelligence-platform> docker compose exec redis redis-cli SET lock:account:1001 test-token NX PX 60000
OK
PS D:\Production-Intelligence-Incident-Platform\production-intelligence-platform> docker compose exec redis redis-cli GET lock:account:1001
"test-token"
PS D:\Production-Intelligence-Incident-Platform\production-intelligence-platform> docker compose exec redis redis-cli SET lock:account:1001 another-token NX PX 60000
(nil)
PS D:\Production-Intelligence-Incident-Platform\production-intelligence-platform> docker compose exec redis redis-cli GET lock:account:1001
"test-token"
PS D:\Production-Intelligence-Incident-Platform\production-intelligence-platform> 


```

The second acquisition failed because the lock already exists.

### 6.3 Inspect ownership and expiration

```powershell
docker compose exec redis redis-cli GET lock:account:1001
docker compose exec redis redis-cli TTL lock:account:1001
```

The first command should return `test-token`. The second should return a positive number of seconds while the key exists.

### 6.4 Test expiration

Wait for the 10-second TTL to expire, then run:

```powershell
docker compose exec redis redis-cli EXISTS lock:account:1001
```

Expected output:

```text
(integer) 0
```

The key should no longer exist.

If the lock expires before you run the inspection commands, repeat the acquisition command.

---

## 7. Break It Intentionally

### Experiment A: Remove `NX`

In a temporary Redis CLI experiment, run:

```powershell
docker compose exec redis redis-cli SET lock:account:1001 owner-A PX 10000
docker compose exec redis redis-cli SET lock:account:1001 owner-B PX 10000
docker compose exec redis redis-cli GET lock:account:1001
```

The final command returns `owner-B`. The second `SET` overwrote the first owner because `NX` was missing.

**Root cause:** Without `NX`, the operation is not conditional on the key being absent.

**Fix:** Keep `NX` in lock acquisition.

### Experiment B: Release with the wrong token

Acquire a lock:

```powershell
docker compose exec redis redis-cli SET lock:account:1001 owner-A NX PX 10000
```

Now attempt an unconditional deletion:

```powershell
docker compose exec redis redis-cli DEL lock:account:1001
```

This deletes the key regardless of ownership.

**Root cause:** `DEL` does not check the owner token.

**Fix:** Use the Lua release script from the service. It deletes the lock only if the stored token matches the supplied token.

### Experiment C: Use a zero TTL

Call `acquire("report:1001", 0)` through the service test.

Expected result: the service rejects the request before contacting Redis.

**Root cause:** A lock with an invalid or zero TTL cannot provide the intended lease.

**Fix:** Validate TTL before sending the Redis command.

---

## 8. Production Considerations

### A. Always release in `finally`

When using the service around a critical section, the calling code should follow this pattern:

```ts
const token = await distributedLockService.acquire(
  "report:1001",
  10_000
);

if (!token) {
  throw new Error("Report is already being processed");
}

try {
  // Perform the protected operation here.
} finally {
  await distributedLockService.release("report:1001", token);
}
```

This is a usage example, not a new route or production report implementation.

The `finally` block runs after normal completion or an exception. However, it cannot run if the process is killed or crashes, which is why TTL matters.

In production, ensure that a Redis release failure is logged and handled deliberately. Do not accidentally hide the original operation error with an unexamined cleanup error.

### B. A TTL is a lease, not an unlimited lock

Suppose Process A acquires a lock for 10 seconds but continues working for 20 seconds. After the TTL expires, Process B can acquire the lock while A is still running.

Both processes may then execute the critical section.

A TTL alone therefore does **not** guarantee mutual exclusion for work that can outlive the lease.

Possible safeguards include:

- Choose a TTL that is appropriate for the operation.
- Renew leases safely when long-running work requires it.
- Use fencing tokens to prevent stale owners from writing.
- Use PostgreSQL transactions, constraints, or row-level locks when the protected operation is database-specific.

Lease renewal and fencing tokens will be studied in a later lecture.

### C. Redis locks are not a substitute for idempotency

A lock helps coordinate concurrent execution. Idempotency helps prevent duplicate business effects when work is retried or delivered more than once.

Your BullMQ workers may need both, depending on the operation.

### D. Do not assume a Redis lock guarantees exactly-once processing

A worker can crash after completing a business operation but before acknowledging its queue job. BullMQ may retry the job. A lock does not remove this possibility.

Use the idempotency pattern from Lecture 1 for business effects that must not be duplicated.

### E. Do not use a distributed lock unnecessarily

If one PostgreSQL row must be updated safely, a database transaction or `SELECT ... FOR UPDATE` may be the better solution. Redis locks are most useful when coordinating a shared operation across independent processes or services that cannot rely on a single database transaction.

---

## 9. Final Checklist

- [ ] Understand why a local JavaScript mutex does not coordinate multiple processes.
- [ ] Create or verify `src/services/distributed-lock.service.ts`.
- [ ] Use atomic `SET ... NX PX` acquisition.
- [ ] Generate a unique owner token.
- [ ] Release using an atomic token-checking Lua script.
- [ ] Run the seven unit tests.
- [ ] Run `npm run build`.
- [ ] Verify lock acquisition and expiration in Redis.
- [ ] Understand what happens if a lease expires while work is still running.
- [ ] Keep idempotency and database-level consistency protections where required.

## 10. Success Criteria

Lecture 2 is complete when the tests pass, the project builds, and you can explain why both `NX` and token-checked release are necessary.

**Next: Module 3 — Lecture 3: Redis Locks and Safe Lock Release in a Background Worker.** We will integrate lock coordination with BullMQ processing and discuss contention, retries, and worker behavior without replacing your existing worker lifecycle.
