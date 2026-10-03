# Production Intelligence & Incident Platform

# Module 2 — Lecture 2: Redis Data Structures & Atomic Operations

> **Learning method**
>
> **Understand → Implement → Inspect → Break → Fix → Verify**
>
> In Lecture 1 we established Redis connectivity and lifecycle.
>
> In this lecture we go one level deeper:
>
> **Redis data structures + atomic operations.**
>
> We still do **not** introduce BullMQ.

---

# Table of Contents

1. [Lecture Objective](#1-lecture-objective)
2. [What We Already Have](#2-what-we-already-have)
3. [Redis Mental Model](#3-redis-mental-model)
4. [Redis Keys](#4-redis-keys)
5. [Data Type 1 — Strings](#5-data-type-1--strings)
6. [Data Type 2 — Hashes](#6-data-type-2--hashes)
7. [Data Type 3 — Lists](#7-data-type-3--lists)
8. [Data Type 4 — Sets](#8-data-type-4--sets)
9. [Data Type 5 — Sorted Sets](#9-data-type-5--sorted-sets)
10. [Data Type 6 — Streams](#10-data-type-6--streams)
11. [Expiration and TTL](#11-expiration-and-ttl)
12. [Atomic Operations](#12-atomic-operations)
13. [Counters](#13-counters)
14. [Race Condition Demonstration](#14-race-condition-demonstration)
15. [MULTI / EXEC](#15-multi--exec)
16. [WATCH](#16-watch)
17. [Why Atomicity Matters](#17-why-atomicity-matters)
18. [Build a Redis Playground Service](#18-build-a-redis-playground-service)
19. [Create Redis Service](#19-create-redis-service)
20. [Create Redis Tests](#20-create-redis-tests)
21. [Run Tests](#21-run-tests)
22. [Intentional Failure](#22-intentional-failure)
23. [Verify Redis Persistence](#23-verify-redis-persistence)
24. [Important Redis Rules](#24-important-redis-rules)
25. [Production Considerations](#25-production-considerations)
26. [Final Architecture](#26-final-architecture)
27. [Final Folder Structure](#27-final-folder-structure)
28. [Verification Checklist](#28-verification-checklist)
29. [Questions You Must Answer](#29-questions-you-must-answer)
30. [Success Criteria](#30-success-criteria)
31. [Next Lecture](#31-next-lecture)

---

# 1. Lecture Objective

At the end of this lecture you should understand:

```text
String
Hash
List
Set
Sorted Set
Stream
TTL
INCR
DECR
MULTI
EXEC
WATCH
```

More importantly, you should understand **why** these primitives exist.

Redis is not just:

```
SET key value
GET key
```

Redis provides several data structures that solve different backend problems.

---

# 2. What We Already Have

From Lecture 1:

```
Node.js
   │
   ▼
ioredis
   │
   ▼
Redis
```

Docker:

```
API
 │
 └── redis:6379
       │
       ▼
     Redis
```

Our application also has:

```
PostgreSQL
Redis
Express
TypeScript
Docker
Docker Compose
```

We now need to understand what we can actually do with Redis.

---

# 3. Redis Mental Model

Think about Redis as:

```
Redis
 │
 ├── key
 │    └── value
 │
 ├── key
 │    └── value
 │
 └── key
      └── value
```

But the value is not always a simple string.

It can be:

```
String
Hash
List
Set
Sorted Set
Stream
```

For example:

```
user:100
   │
   └── Hash
       ├── name
       ├── email
       └── status
```

Another key:

```
worker:queue
   │
   └── List
       ├── job1
       ├── job2
       └── job3
```

Another:

```
online-users
   │
   └── Set
       ├── user1
       ├── user2
       └── user3
```

The data structure should match the problem.

---

# 4. Redis Keys

A good Redis key naming convention is extremely important.

Bad:

```
user
data
test
queue
```

Better:

```
user:1001
user:1002

incident:123

worker:worker-1

queue:email

rate-limit:192.168.1.10
```

A common pattern is:

```
namespace:identifier
```

For example:

```
incident:123
```

means:

```
namespace = incident
identifier = 123
```

For nested concepts:

```
incident:123:events
```

or:

```
worker:worker-1:stats
```

---

# 5. Data Type 1 — Strings

Strings are the simplest Redis data type.

## SET

Run:

```
docker compose exec redis redis-cli `
  SET lecture:string "hello-redis"
```

Expected:

```
OK
```

---

## GET

```
docker compose exec redis redis-cli `
  GET lecture:string
```

Expected:

```
"hello-redis"
```

---

## EXISTS

```
docker compose exec redis redis-cli `
  EXISTS lecture:string
```

Expected:

```
(integer) 1
```

---

## DELETE

```
docker compose exec redis redis-cli `
  DEL lecture:string
```

Expected:

```
(integer) 1
```

---

# 6. Strings Are More Powerful Than They Look

Strings can also store numbers.

Run:

```
docker compose exec redis redis-cli `
  SET counter 10
```

Then:

```
docker compose exec redis redis-cli `
  INCR counter
```

Expected:

```
(integer) 11
```

Again:

```
docker compose exec redis redis-cli `
  INCR counter
```

Expected:

```
(integer) 12
```

---

# 7. INCR Is Atomic

This is extremely important.

Consider:

```
counter = 10
```

An application could theoretically do:

```
GET counter
   ↓
10

10 + 1
   ↓
11

SET counter 11
```

That involves multiple operations.

Redis provides:

```
INCR counter
```

as one atomic operation.

Conceptually:

```
INCR
 │
 ├── read
 ├── increment
 └── write
```

happens atomically from the perspective of other Redis commands.

This becomes extremely useful for:

```
request counters
rate limiting
job counters
retry counters
metrics
```

---

# 8. DECR

Run:

```
docker compose exec redis redis-cli `
  DECR counter
```

Expected:

```
(integer) 11
```

---

# 9. INCRBY

Run:

```
docker compose exec redis redis-cli `
  INCRBY counter 10
```

If the value was:

```
11
```

the result becomes:

```
21
```

You can also use:

```
DECRBY
```

---

# 10. Data Type 2 — Hashes

A Redis hash represents fields associated with one key.

Think:

```
incident:1001
    │
    ├── service = payment
    ├── severity = critical
    └── status = detected
```

Create:

```
docker compose exec redis redis-cli `
  HSET incident:1001 `
  service payment `
  severity critical `
  status detected
```

Expected:

```
(integer) 3
```

---

# 11. HGET

Get one field:

```
docker compose exec redis redis-cli `
  HGET incident:1001 service
```

Expected:

```
"payment"
```

Get severity:

```
docker compose exec redis redis-cli `
  HGET incident:1001 severity
```

Expected:

```
"critical"
```

---

# 12. HGETALL

Run:

```
docker compose exec redis redis-cli `
  HGETALL incident:1001
```

Expected conceptually:

```
service
payment
severity
critical
status
detected
```

---

# 13. HINCRBY

Hashes also support atomic numeric operations.

Create:

```
docker compose exec redis redis-cli `
  HSET worker:1 completed 0
```

Then:

```
docker compose exec redis redis-cli `
  HINCRBY worker:1 completed 1
```

Expected:

```
(integer) 1
```

Again:

```
docker compose exec redis redis-cli `
  HINCRBY worker:1 completed 1
```

Expected:

```
(integer) 2
```

This becomes very useful for worker statistics later.

---

# 14. Data Type 3 — Lists

A Redis list is an ordered collection.

Think:

```
jobs
 │
 ├── job-1
 ├── job-2
 └── job-3
```

Add values:

```
docker compose exec redis redis-cli `
  RPUSH lecture:list job-1 job-2 job-3
```

Expected:

```
(integer) 3
```

---

# 15. Read a List

Run:

```
docker compose exec redis redis-cli `
  LRANGE lecture:list 0 -1
```

Expected:

```
job-1
job-2
job-3
```

The:

```
0 -1
```

means:

```
first element → last element
```

---

# 16. Remove From List

Run:

```
docker compose exec redis redis-cli `
  LPOP lecture:list
```

Expected:

```
"job-1"
```

Now:

```
docker compose exec redis redis-cli `
  LRANGE lecture:list 0 -1
```

Expected:

```
job-2
job-3
```

---

# 17. Important Queue Connection

A list can conceptually be used for:

```
Producer
   │
   ▼
RPUSH
   │
   ▼
Redis List
   │
   ▼
LPOP
   │
   ▼
Consumer
```

However:

> **Do not build our production job queue using a raw Redis List.**

Later we will use:

```
BullMQ
```

because it provides much more sophisticated job-management behavior.

---

# 18. Data Type 4 — Sets

A Set stores unique values.

Add:

```
docker compose exec redis redis-cli `
  SADD online-users user-1 user-2 user-3
```

Expected:

```
(integer) 3
```

Add `user-1` again:

```
docker compose exec redis redis-cli `
  SADD online-users user-1
```

Expected:

```
(integer) 0
```

Why?

Because:

```
user-1
```

already exists.

---

# 19. Read Set Members

```
docker compose exec redis redis-cli `
  SMEMBERS online-users
```

You should see:

```
user-1
user-2
user-3
```

Order is not guaranteed.

This is a major difference from Lists.

---

# 20. Check Membership

Run:

```
docker compose exec redis redis-cli `
  SISMEMBER online-users user-2
```

Expected:

```
(integer) 1
```

Unknown user:

```
docker compose exec redis redis-cli `
  SISMEMBER online-users user-99
```

Expected:

```
(integer) 0
```

Sets are useful for:

```
unique users
unique worker IDs
feature membership
deduplication
active resources
```

---

# 21. Data Type 5 — Sorted Sets

Sorted Sets combine:

```
unique values
+
numeric scores
```

For example:

```
worker-1 → 100
worker-2 → 80
worker-3 → 90
```

Add:

```
docker compose exec redis redis-cli `
  ZADD worker-performance 100 worker-1 80 worker-2 90 worker-3
```

Expected:

```
(integer) 3
```

---

# 22. Read Sorted Set

```
docker compose exec redis redis-cli `
  ZRANGE worker-performance 0 -1 WITHSCORES
```

Expected order:

```
worker-2
80
worker-3
90
worker-1
100
```

Sorted Sets are useful for:

```
leaderboards
priority-like ordering
ranking
scheduled data
score-based selection
```

We will revisit this concept later.

---

# 23. Data Type 6 — Streams

Redis Streams are an append-oriented data structure designed for event-like data.

Conceptually:

```
Stream
 │
 ├── event-1
 ├── event-2
 ├── event-3
 └── event-4
```

Add an event:

```
docker compose exec redis redis-cli `
  XADD lecture-stream "*" `
  event incident-created `
  service payment
```

Redis returns an ID similar to:

```
"176..."
```

The exact value will be different.

---

# 24. Read the Stream

Run:

```
docker compose exec redis redis-cli `
  XRANGE lecture-stream - +
```

You should see the event.

Streams become particularly interesting when we discuss:

```
event-driven architecture
consumer groups
event processing
```

later in the course.

---

# 25. Clean Up Lecture Keys

We have created several demonstration keys.

Remove them:

```
docker compose exec redis redis-cli `
  DEL counter incident:1001 worker:1 lecture:list online-users worker-performance lecture-stream
```

You can inspect the remaining keys:

```
docker compose exec redis redis-cli KEYS "lecture:*"
```

If nothing remains:

```
(empty array)
```

---

# 26. WARNING — `KEYS`

You just saw:

```
KEYS "*"
```

or:

```
KEYS "lecture:*"
```

This is fine for:

```
local development
debugging
learning
```

But do **not** casually use:

```
KEYS "*"
```

on a large production Redis instance.

Why?

Redis may need to scan a very large keyspace.

Later we will use:

```
SCAN
```

for safer keyspace inspection.

---

# 27. Expiration and TTL

Expiration is one of Redis's most useful features.

Set:

```
docker compose exec redis redis-cli `
  SET session:1001 active EX 60
```

Now:

```
docker compose exec redis redis-cli `
  TTL session:1001
```

You should get approximately:

```
(integer) 60
```

---

# 28. EXPIRE

You can also set expiration after creating the key.

Run:

```
docker compose exec redis redis-cli `
  SET temporary:data hello
```

Then:

```
docker compose exec redis redis-cli `
  EXPIRE temporary:data 30
```

Expected:

```
(integer) 1
```

Now:

```
docker compose exec redis redis-cli `
  TTL temporary:data
```

---

# 29. PERSIST

You can remove the expiration:

```
docker compose exec redis redis-cli `
  PERSIST temporary:data
```

Expected:

```
(integer) 1
```

Now:

```
docker compose exec redis redis-cli `
  TTL temporary:data
```

Expected:

```
(integer) -1
```

Meaning:

```
key exists
but has no expiration
```

---

# 30. Why TTL Matters

Later we can use expiration for:

```
temporary locks
rate limits
sessions
cache entries
idempotency keys
temporary worker state
```

Example:

```
idempotency:request-123
        │
        ▼
     24 hours
        │
        ▼
    automatically removed
```

---

# 31. Atomic Operations

Now we reach the most important concept of this lecture.

Suppose:

```
counter = 100
```

Two workers want to increment it.

Bad conceptual implementation:

```
Worker A:
GET counter → 100

Worker B:
GET counter → 100

Worker A:
SET counter 101

Worker B:
SET counter 101
```

Final value:

```
101
```

Expected:

```
102
```

This is a race condition.

---

# 32. Atomic INCR Solves This Case

Instead:

```
Worker A:
INCR counter

Worker B:
INCR counter
```

Redis processes commands sequentially.

Conceptually:

```
INCR → 101
INCR → 102
```

Final:

```
102
```

This is one of the reasons Redis is useful for distributed systems.

---

# 33. Test Atomic Increment

Set:

```
docker compose exec redis redis-cli `
  SET atomic-counter 0
```

Then:

```
docker compose exec redis redis-cli `
  INCR atomic-counter
```

Then:

```
docker compose exec redis redis-cli `
  GET atomic-counter
```

Expected:

```
"1"
```

---

# 34. Atomic Hash Increment

Run:

```
docker compose exec redis redis-cli `
  HSET worker:stats completed 0
```

Then:

```
docker compose exec redis redis-cli `
  HINCRBY worker:stats completed 5
```

Expected:

```
(integer) 5
```

Then:

```
docker compose exec redis redis-cli `
  HGET worker:stats completed
```

Expected:

```
"5"
```

---

# 35. MULTI / EXEC

Redis provides transaction-like command grouping through:

```
MULTI
EXEC
```

The important mental model is:

```
MULTI
  │
  ├── command 1
  ├── command 2
  └── command 3
  │
  ▼
EXEC
```

The commands are queued and then executed together.

---

# 36. Test MULTI / EXEC

Run:

```
docker compose exec redis redis-cli
```

You will enter the Redis CLI.

Then:

```
MULTI
```

Then:

```
SET transaction:key "hello"
```

Then:

```
INCR transaction:counter
```

Then:

```
EXEC
```

You should see the command results.

Exit:

```
exit
```

---

# 37. Important MULTI Concept

Do not think of:

```
MULTI / EXEC
```

as equivalent to a PostgreSQL transaction.

Redis transactions have different semantics.

The key idea for now is:

```
commands are queued
        ↓
EXEC
        ↓
commands execute sequentially
```

We will go deeper into Redis transaction semantics later.

---

# 38. WATCH

`WATCH` is used for optimistic concurrency control.

Conceptually:

```
WATCH key
    │
    ▼
read key
    │
    ▼
calculate new value
    │
    ▼
MULTI
    │
    ▼
SET key
    │
    ▼
EXEC
```

If another client changes the watched key before `EXEC`, the transaction can be aborted.

This is useful for:

```
compare-and-set style operations
optimistic concurrency
conditional updates
```

---

# 39. Why We Need WATCH

Imagine:

```
balance = 100
```

Worker A:

```
WATCH balance
```

Worker A reads:

```
100
```

Before A commits, Worker B changes:

```
balance = 50
```

A then tries to update based on the old value.

Without protection:

```
stale calculation
```

With:

```
WATCH
```

Redis can detect that the key changed.

---

# 40. Redis Atomicity vs PostgreSQL Transactions

Important distinction:

```
PostgreSQL
    ↓
relational transaction system
```

Redis:

```
Redis
    ↓
single-threaded command execution
    +
MULTI/EXEC
    +
WATCH
```

They solve related but different problems.

Do not blindly transfer PostgreSQL transaction concepts to Redis.

---

# 41. Build a Redis Service

Now we will connect the concepts to our TypeScript application.

Create:

## File: `src/services/redis.service.ts`

```
import {
  redis
} from "../redis/client.js";

export class RedisService {
  async set(
    key: string,
    value: string
  ): Promise<void> {
    await redis.set(
      key,
      value
    );
  }

  async get(
    key: string
  ): Promise<string | null> {
    return redis.get(key);
  }

  async delete(
    key: string
  ): Promise<void> {
    await redis.del(key);
  }

  async increment(
    key: string
  ): Promise<number> {
    return redis.incr(key);
  }

  async setWithExpiration(
    key: string,
    value: string,
    ttlSeconds: number
  ): Promise<void> {
    await redis.set(
      key,
      value,
      "EX",
      ttlSeconds
    );
  }
}
```

---

# 42. Why Create a Redis Service?

We could call:

```
redis.get(...)
```

everywhere.

But that would spread infrastructure knowledge throughout the application.

Instead:

```
Controller
   │
   ▼
Service
   │
   ▼
RedisService
   │
   ▼
ioredis
   │
   ▼
Redis
```

This gives us a place to eventually add:

```
logging
metrics
error handling
serialization
key conventions
timeouts
```

without changing every caller.

---

# 43. Create Redis Service Instance

## File: `src/container.ts`

Add:

```
import { RedisService } from "./services/redis.service.js";

export const redisService =
  new RedisService();
```

If `src/container.ts` already contains the existing dependency-injection code, **do not delete it**.

Add the import and export alongside the existing dependencies.

For example:

```
import {
  IncidentRepository
} from "./repositories/incident.repository.js";

import {
  IncidentEventRepository
} from "./repositories/incident-event.repository.js";

import {
  IncidentService
} from "./services/incident.service.js";

import {
  RedisService
} from "./services/redis.service.js";

const incidentRepository =
  new IncidentRepository();

const incidentEventRepository =
  new IncidentEventRepository();

export const incidentService =
  new IncidentService(
    incidentRepository,
    incidentEventRepository
  );

export const redisService =
  new RedisService();
```

---

# 44. Create Redis Service Tests

Create:

## File: `tests/redis/redis.service.test.ts`

First create the directory:

```
New-Item `
  -ItemType Directory `
  -Force `
  tests\redis
```

Then:

```
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import {
  connectRedis,
  closeRedis
} from "../../src/redis/lifecycle.js";

import {
  redis
} from "../../src/redis/client.js";

import {
  RedisService
} from "../../src/services/redis.service.js";

const redisService =
  new RedisService();

describe(
  "RedisService",
  () => {
    beforeAll(
      async () => {
        await connectRedis();
      }
    );

    beforeEach(
      async () => {
        await redis.flushdb();
      }
    );

    afterAll(
      async () => {
        await closeRedis();
      }
    );

    it(
      "sets and gets a value",
      async () => {
        await redisService.set(
          "test:key",
          "hello"
        );

        const value =
          await redisService.get(
            "test:key"
          );

        expect(value).toBe(
          "hello"
        );
      }
    );

    it(
      "returns null for a missing key",
      async () => {
        const value =
          await redisService.get(
            "missing:key"
          );

        expect(value).toBeNull();
      }
    );

    it(
      "increments a counter",
      async () => {
        const first =
          await redisService.increment(
            "test:counter"
          );

        const second =
          await redisService.increment(
            "test:counter"
          );

        expect(first).toBe(1);
        expect(second).toBe(2);
      }
    );

    it(
      "sets a value with expiration",
      async () => {
        await redisService
          .setWithExpiration(
            "test:ttl",
            "temporary",
            30
          );

        const value =
          await redisService.get(
            "test:ttl"
          );

        const ttl =
          await redis.ttl(
            "test:ttl"
          );

        expect(value).toBe(
          "temporary"
        );

        expect(ttl).toBeGreaterThan(
          0
        );
      }
    );

    it(
      "deletes a key",
      async () => {
        await redisService.set(
          "test:delete",
          "value"
        );

        await redisService.delete(
          "test:delete"
        );

        const value =
          await redisService.get(
            "test:delete"
          );

        expect(value).toBeNull();
      }
    );
  }
);
```

---

# 45. Important Testing Warning

This test uses:

```
redis.flushdb()
```

That is acceptable for our **isolated development/test Redis database**.

Do not use:

```
FLUSHDB
FLUSHALL
```

against a production Redis instance without understanding exactly what data will be destroyed.

We are intentionally keeping:

```
test environment
```

separate from production.

---

# 46. Run Redis Service Tests

First make sure Redis is running:

```
docker compose up -d redis
```

Then:

```
npm run test:run -- tests/redis/redis.service.test.ts
```

Expected:

```
PASS
```

---

# 47. Run Complete Test Suite

Run:

```
npm run test:run
```

Then:

```
npm run build
```

Both must pass.

---

# 48. Intentional Failure

Now we intentionally break the Redis connection.

Stop Redis:

```
docker compose stop redis
```

Now run:

```
npm run test:run -- tests/redis/redis.service.test.ts
```

The Redis tests should fail because the infrastructure dependency is unavailable.

This is expected.

The purpose is to prove:

```
tests
  ↓
Redis dependency
  ↓
Redis unavailable
  ↓
failure is visible
```

---

# 49. Recover

Start Redis:

```
docker compose start redis
```

Verify:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

Run:

```
npm run test:run -- tests/redis/redis.service.test.ts
```

The tests should pass again.

---

# 50. Verify Redis Data After Restart

Set:

```
docker compose exec redis redis-cli `
  SET persistence:test "hello"
```

Read:

```
docker compose exec redis redis-cli `
  GET persistence:test
```

Expected:

```
"hello"
```

Now restart Redis:

```
docker compose restart redis
```

Wait for healthy:

```
docker compose ps redis
```

Then:

```
docker compose exec redis redis-cli `
  GET persistence:test
```

Because we enabled AOF persistence and a Redis volume, the value should persist across the container restart.

---

# 51. Important Persistence Lesson

This demonstrates:

```
Redis
 │
 ├── memory
 │
 └── persistence
       │
       ▼
   redis_data
```

But again:

> This does not mean Redis becomes our primary business database.

Our architecture remains:

```
Business data
      ↓
PostgreSQL
```

Redis:

```
Fast state
coordination
temporary data
queue infrastructure
```

---

# 52. Inspect Redis Memory

Run:

```
docker compose exec redis `
  redis-cli INFO memory
```

You can inspect values such as:

```
used_memory
used_memory_human
maxmemory
```

This becomes important later because Redis is memory-sensitive.

---

# 53. Inspect Redis Database Size

Run:

```
docker compose exec redis `
  redis-cli DBSIZE
```

This returns the number of keys in the selected Redis database.

Example:

```
(integer) 4
```

The exact number depends on what you've created.

---

# 54. Inspect Redis Server Information

Run:

```
docker compose exec redis `
  redis-cli INFO server
```

Useful fields include:

```
redis_version
os
process_id
uptime_in_seconds
```

---

# 55. Atomic Operation Example

Let's model a worker counter.

Initial:

```
worker:1
    completed = 0
```

Run:

```
docker compose exec redis `
  redis-cli HSET worker:1 completed 0
```

Then simulate jobs:

```
docker compose exec redis `
  redis-cli HINCRBY worker:1 completed 1
```

Repeat:

```
docker compose exec redis `
  redis-cli HINCRBY worker:1 completed 1
```

Then:

```
docker compose exec redis `
  redis-cli HGET worker:1 completed
```

Expected:

```
"2"
```

This is a primitive we will eventually use for worker/job metrics.

---

# 56. Atomic Counter Example

A rate limiter might conceptually do:

```
rate-limit:user:1001
       │
       ▼
      1
       │
       ▼
      2
       │
       ▼
      3
```

using:

```
INCR
```

and:

```
EXPIRE
```

For example:

```
INCR rate-limit:user:1001
EXPIRE rate-limit:user:1001 60
```

Later we will implement a proper rate-limiting pattern.

---

# 57. Redis Commands We Learned

## Strings

```
SET
GET
DEL
EXISTS
INCR
DECR
INCRBY
DECRBY
```

## Hashes

```
HSET
HGET
HGETALL
HDEL
HINCRBY
```

## Lists

```
LPUSH
RPUSH
LPOP
RPOP
LRANGE
```

## Sets

```
SADD
SREM
SMEMBERS
SISMEMBER
```

## Sorted Sets

```
ZADD
ZRANGE
```

## Streams

```
XADD
XRANGE
```

## Expiration

```
EXPIRE
TTL
PERSIST
```

## Transactions / Concurrency

```
MULTI
EXEC
WATCH
```

---

# 58. Redis Command Families

Do not memorize every Redis command.

Instead, learn the patterns.

```
String
  SET
  GET
  INCR

Hash
  HSET
  HGET
  HINCRBY

List
  LPUSH
  RPUSH
  LPOP
  RPOP

Set
  SADD
  SREM
  SISMEMBER

Sorted Set
  ZADD
  ZRANGE

Stream
  XADD
  XREAD
```

This makes learning much easier.

---

# 59. Production Consideration — Serialization

Redis values are strings/bytes at the protocol level.

Suppose you have:

```
const incident = {
  id: "123",
  service: "payment",
  severity: "critical"
};
```

You could serialize it:

```
JSON.stringify(incident)
```

and store:

```
SET incident:123 "{...}"
```

Then:

```
JSON.parse(value)
```

would reconstruct the object.

But this is not always the best choice.

Sometimes a Redis Hash is more appropriate:

```
incident:123
    │
    ├── service
    ├── severity
    └── status
```

The data model should match the access pattern.

---

# 60. Production Consideration — Key Design

Prefer:

```
incident:123
worker:worker-1
job:123
rate-limit:user:123
lock:incident:123
```

over:

```
abc
xyz
data1
thing
```

Good keys make production debugging dramatically easier.

Later, when we inspect Redis:

```
SCAN
```

we should immediately understand what a key represents.

---

# 61. Production Consideration — TTL

If data is temporary, consider whether it needs:

```
TTL
```

Examples:

```
session
temporary lock
cache
idempotency record
rate-limit counter
temporary worker state
```

A key without expiration can remain indefinitely.

That can eventually cause memory pressure.

---

# 62. Production Consideration — Memory

Redis is memory-oriented.

Therefore:

```
More keys
    +
larger values
    +
longer retention
    =
more memory
```

We must eventually understand:

```
maxmemory
eviction policy
memory monitoring
```

before using Redis heavily in production.

---

# 63. Production Consideration — `KEYS`

Never casually write production code such as:

```
KEYS *
```

Prefer:

```
SCAN
```

because `SCAN` can iterate through the keyspace incrementally.

This is an important operational habit.

---

# 64. Production Consideration — Atomic Does Not Mean Magical

Redis provides atomic operations.

But atomicity doesn't automatically solve every distributed-system problem.

For example:

```
INCR
```

solves:

```
atomic counter increment
```

It does not automatically solve:

```
distributed locking
leader election
exactly-once processing
network partitions
worker crashes
```

Those come later.

---

# 65. What We Have Built

Our application now has:

```
                    API
                     │
                     ▼
                  Service
                     │
                     ▼
                RedisService
                     │
                     ▼
                  ioredis
                     │
                     ▼
                   Redis
```

Redis itself supports:

```
Strings
Hashes
Lists
Sets
Sorted Sets
Streams
```

and primitives:

```
TTL
INCR
MULTI
EXEC
WATCH
```

This is the foundation for the queue system.

---

# 66. Final Architecture

```
                         Docker Network
                         app-network
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   ┌─────────┐          ┌────────────┐        ┌────────────┐
   │   API   │          │ PostgreSQL │        │   Redis    │
   │         │          │            │        │            │
   │ Express │          │ incidents  │        │ Strings    │
   │         │          │ events     │        │ Hashes     │
   │ ioredis │          │            │        │ Lists      │
   └────┬────┘          └────────────┘        │ Sets       │
        │                                      │ ZSets      │
        │                                      │ Streams    │
        ▼                                      └────────────┘
   RedisService
```

---

# 67. Final Folder Structure

After Lecture 2:

```
production-intelligence-platform/
│
├── src/
│   │
│   ├── config/
│   │   ├── config.types.ts
│   │   ├── env.ts
│   │   └── rate-limit.ts
│   │
│   ├── controllers/
│   │   ├── health.controller.ts
│   │   └── incident.controller.ts
│   │
│   ├── database/
│   │   ├── migrations/
│   │   │   ├── 001_create_incidents.sql
│   │   │   ├── 002_create_incident_events.sql
│   │   │   ├── 003_add_incident_indexes.sql
│   │   │   ├── 004_add_incident_acknowledged_at.sql
│   │   │   ├── 005_add_incident_domain_constraints.sql
│   │   │   └── 006_add_incident_event_constraints.sql
│   │   ├── health.ts
│   │   ├── migrate.ts
│   │   ├── pool.ts
│   │   └── transaction.ts
│   │
│   ├── domain/
│   │   ├── incident.ts
│   │   ├── incident-query.ts
│   │   └── pagination.ts
│   │
│   ├── errors/
│   │   ├── AppError.ts
│   │   ├── NotFoundError.ts
│   │   └── ValidationError.ts
│   │
│   ├── logging/
│   │   ├── log-level.ts
│   │   ├── logger.ts
│   │   └── request-context.ts
│   │
│   ├── middleware/
│   │   ├── error.middleware.ts
│   │   ├── not-found.middleware.ts
│   │   ├── request-id.middleware.ts
│   │   ├── request-logging.middleware.ts
│   │   ├── security.middleware.ts
│   │   └── validation.middleware.ts
│   │
│   ├── redis/
│   │   ├── client.ts
│   │   └── lifecycle.ts
│   │
│   ├── repositories/
│   │   ├── incident-event.repository.interface.ts
│   │   ├── incident-event.repository.ts
│   │   ├── incident.repository.interface.ts
│   │   └── incident.repository.ts
│   │
│   ├── routes/
│   │   ├── health.routes.ts
│   │   └── incident.routes.ts
│   │
│   ├── server/
│   │   ├── lifecycle.ts
│   │   └── shutdown.ts
│   │
│   ├── services/
│   │   ├── incident.service.ts
│   │   └── redis.service.ts
│   │
│   ├── types/
│   │   └── api-response.ts
│   │
│   ├── utils/
│   │   └── api-response.ts
│   │
│   ├── validators/
│   │   ├── incident-query.validator.ts
│   │   └── incident.validator.ts
│   │
│   ├── app.ts
│   ├── container.ts
│   └── server.ts
│
├── tests/
│   ├── config/
│   │   └── env.test.ts
│   │
│   ├── redis/
│   │   └── redis.service.test.ts
│   │
│   └── ...
│
├── .dockerignore
├── .env
├── .env.example
├── .env.test
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package-lock.json
├── package.json
└── tsconfig.json
```

---

# 68. Verification Checklist

Do not continue until these are verified.

## Redis Data Structures

```
[ ] SET / GET
[ ] DEL
[ ] EXISTS
[ ] INCR
[ ] DECR
[ ] INCRBY

[ ] HSET
[ ] HGET
[ ] HGETALL
[ ] HINCRBY

[ ] RPUSH
[ ] LRANGE
[ ] LPOP

[ ] SADD
[ ] SMEMBERS
[ ] SISMEMBER

[ ] ZADD
[ ] ZRANGE

[ ] XADD
[ ] XRANGE
```

## Expiration

```
[ ] EXPIRE
[ ] TTL
[ ] PERSIST
```

## Concurrency

```
[ ] Understand atomic INCR
[ ] Understand MULTI
[ ] Understand EXEC
[ ] Understand WATCH
```

## Application

```
[ ] RedisService created
[ ] RedisService tests created
[ ] RedisService tests pass
[ ] Full test suite passes
[ ] TypeScript build passes
```

## Failure

```
[ ] Redis stopped
[ ] Tests fail when Redis unavailable
[ ] Redis restarted
[ ] Tests recover
```

---

# 69. Questions You Must Answer

Before Lecture 3, explain these in your own words.

### 1. Why would you choose a Hash instead of a String?

---

### 2. What is the difference between a List and a Set?

---

### 3. Why does a Set reject duplicate values?

---

### 4. When would a Sorted Set be useful?

---

### 5. What does TTL mean?

---

### 6. Why is `INCR` useful in distributed systems?

---

### 7. What problem does `MULTI/EXEC` address?

---

### 8. What problem does `WATCH` address?

---

### 9. Why should we avoid `KEYS *` in production?

---

### 10. Why should Redis not become the source of truth for incidents?

---

# 70. Important Conceptual Summary

You should now think about Redis like this:

```
Redis
│
├── String
│     └── simple values / counters
│
├── Hash
│     └── object-like state
│
├── List
│     └── ordered collection
│
├── Set
│     └── unique membership
│
├── Sorted Set
│     └── score-based ordering
│
└── Stream
      └── event-like data
```

And:

```
TTL
 │
 └── automatic expiration

INCR
 │
 └── atomic counters

MULTI / EXEC
 │
 └── grouped command execution

WATCH
 │
 └── optimistic concurrency
```

---

# 71. Why This Lecture Comes Before BullMQ

BullMQ will eventually give us:

```
Queue
Job
Producer
Worker
Retry
Backoff
Delayed Job
Priority
Concurrency
Events
```

But underneath that infrastructure is Redis.

If we don't understand:

```
keys
data structures
atomicity
expiration
concurrency
```

then BullMQ becomes a black box.

We don't want that.

We want to understand:

```
BullMQ
   │
   ▼
Redis primitives
   │
   ▼
Distributed processing
```

---

# 72. Success Criteria

Lecture 2 is complete when:

```
[✓] Strings understood
[✓] Hashes understood
[✓] Lists understood
[✓] Sets understood
[✓] Sorted Sets understood
[✓] Streams introduced
[✓] TTL understood
[✓] Atomic counters understood
[✓] MULTI/EXEC understood
[✓] WATCH understood
[✓] RedisService implemented
[✓] RedisService tests implemented
[✓] Redis tests pass
[✓] Full test suite passes
[✓] TypeScript build passes
[✓] Redis failure tested
[✓] Redis recovery tested
```

---

# 73. Next Lecture

# Module 2 — Lecture 3

## Redis Connection Management, Retry Strategy & Failure Recovery

We will move from:

```
Redis commands
```

to:

```
Production Redis connectivity
```

Topics will include:

```
connection lifecycle
connection states
ready event
error event
close event
reconnecting
retry strategy
connection failures
Redis unavailable during startup
Redis unavailable during runtime
recovery
timeouts
logging
health checks
```

Then, after the Redis foundation is solid:

```
Redis
   ↓
BullMQ
   ↓
Producer
   ↓
Worker
```

**Do not introduce BullMQ before the Redis connection/recovery layer is understood and verified.**
