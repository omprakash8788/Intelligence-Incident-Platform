# Module 2 — Lecture 20: Queue Sharding & Partitioning Strategies

> **Final lecture of Module 2 — Advanced Queue Patterns**

## Table of Contents

1. Learning Objectives
2. Why Queue Sharding Is Needed
3. Queue Sharding vs. Partitioning
4. Architecture
5. Define the Shard Configuration
6. Define the Job Contract
7. Implement Deterministic Partitioning
8. Create the Sharded Queues
9. Implement the Sharded Worker Pool
10. Implement the Sharding Service
11. Create the API Routes
12. Register the Route
13. Integrate Worker Lifecycle
14. Unit Tests
15. Build and Run
16. API Verification
17. Intentional Break → Understand → Fix
18. Production Trade-offs
19. Final Folder Structure
20. Success Criteria

---

## 1. Learning Objectives

By the end of this lecture, you will understand:

- Why a single queue can become a bottleneck.
- How queue sharding distributes jobs across multiple queues.
- How to use a partition key to keep related jobs on the same shard.
- How to implement deterministic hashing in TypeScript.
- How to create and manage multiple BullMQ queues.
- How to register one worker per shard.
- How to monitor a job when its queue depends on its partition key.
- How to test partitioning without connecting to Redis.
- Why changing the number of shards can break routing consistency.

We will use your existing Node.js, TypeScript, Express, Redis, and BullMQ architecture.

**We will not modify your existing demo, external API, fan-out, pipeline, parent–child, or workload-isolation queues.**

### Our use case

Suppose the platform receives 100,000 jobs related to different services.

Examples:

- `payment-service`
- `authentication-service`
- `notification-service`
- `inventory-service`

If every job enters one queue, the queue may become a bottleneck for high-volume workloads.

We can distribute the jobs across several queues.

However, there is an important requirement: jobs related to the same service should consistently map to the same shard.

That is the purpose of deterministic partitioning.

---

## 2. Why Queue Sharding Is Needed

Consider a single queue:

```text
                     Single Queue
                          |
           +--------------+--------------+
           |              |              |
        Job A           Job B           Job C
           |              |              |
           +--------------+--------------+
                          |
                     Worker Pool
```

A single queue can be perfectly adequate for many applications. Sharding is not automatically better.

But at high volume, a single queue may concentrate enqueue operations, scheduling activity, and waiting jobs in one logical queue.

We can distribute the workload:

```text
                   Partitioning Function
                           |
             +-------------+-------------+
             |             |             |
             v             v             v
          Shard 0        Shard 1        Shard 2
             |             |             |
             v             v             v
          Worker 0      Worker 1      Worker 2
```

Each shard has its own queue and worker.

### Potential benefits

- Independent queue backlogs.
- Independent worker concurrency.
- Easier workload distribution.
- A basis for horizontal scaling.
- A way to partition related work consistently.

### What sharding does not guarantee

Sharding does not automatically guarantee:

- Equal queue depth.
- Lower latency for every job.
- Faster processing if workers are CPU-bound.
- Redis isolation.
- Global ordering across all shards.
- Exactly-once job execution.

Those properties require additional design and measurement.

---

## 3. Queue Sharding vs. Partitioning

These concepts are closely related but have different responsibilities.

| Concept | Responsibility |
|---|---|
| Partition key | Identifies the entity or workload that should be grouped |
| Hash function | Converts a key into a deterministic numeric value |
| Partitioning | Maps the key to a shard index |
| Shard | A partition of the overall workload |
| Queue | Holds jobs assigned to a shard |
| Worker | Processes jobs from a particular queue |

For example:

```text
partitionKey = "payment-service"
```

Our hash function calculates a numeric hash and maps it to one of three shards:

```text
hash("payment-service") % 3
```

The result is one of:

```text
0, 1, or 2
```

Every time we use the same algorithm, the same key, and the same shard count, the key maps to the same shard.

### Important limitation

A deterministic hash does not guarantee that every shard receives the same number of jobs.

If one service generates 80% of all traffic, hashing by service name may still create a hot shard.

We will examine this in the production trade-offs section.

---

## 4. Architecture

We will build three shards.

```text
POST /demo/sharded-jobs
          |
          v
    Validate Input
          |
          v
    Partition Key
          |
          v
    Hash Function
          |
          v
    Shard Index 0, 1, or 2
          |
     +----+----+
     |    |    |
     v    v    v
   Q-0   Q-1   Q-2
     |    |    |
     v    v    v
    W-0  W-1  W-2
     |    |    |
     +----+----+
          |
          v
   Process the Job
```

The submission API returns the shard index, queue name, and BullMQ job ID.

The status API accepts the shard index and job ID, allowing us to look up the job in the correct queue.

### Files to create

| Action | File |
|---|---|
| Create | `src/queues/sharding.config.ts` |
| Create | `src/queues/jobs/sharded-job.ts` |
| Create | `src/queues/sharded.queues.ts` |
| Create | `src/services/sharding.policy.ts` |
| Create | `src/services/sharded-job.service.ts` |
| Create | `src/workers/sharded.worker.ts` |
| Create | `src/routes/sharded-job.routes.ts` |
| Create | `tests/sharding.policy.test.ts` |
| Modify | `src/app.ts` |
| Modify | `src/workers.ts` |

We will reuse your existing `createBullMQConnection()` function.

---

## 5. Define the Shard Configuration

**File: `src/queues/sharding.config.ts`**

**Action: CREATE this file.**

```ts
export const SHARD_COUNT = 3;

export const SHARDED_QUEUE_NAMES = [
  "sharded-workload-0",
  "sharded-workload-1",
  "sharded-workload-2"
] as const;

if (SHARDED_QUEUE_NAMES.length !== SHARD_COUNT) {
  throw new Error(
    "SHARD_COUNT must match SHARDED_QUEUE_NAMES.length"
  );
}
```

### Why centralize this configuration?

The producer, worker, monitoring endpoint, and tests must agree on the number and names of the shards.

If these values are duplicated across multiple files, changing the configuration can accidentally create queues that no worker consumes.

The explicit check catches a mismatch at startup.

### Why start with three shards?

Three is a manageable number for learning and testing.

It is not a recommended production default. Real shard counts should be based on queue throughput, worker capacity, operational overhead, and expected growth.

---

## 6. Define the Job Contract

**File: `src/queues/jobs/sharded-job.ts`**

**Action: CREATE this file.**

```ts
export interface ShardedJobData {
  partitionKey: string;
  shardIndex: number;
  message: string;
  submittedAt: string;
}

export interface ShardedJobResult {
  partitionKey: string;
  shardIndex: number;
  originalMessage: string;
  processedMessage: string;
  processedAt: string;
}
```

### Why include the partition key in the job data?

It helps us correlate jobs belonging to the same service or business entity.

For example, all jobs with:

```text
partitionKey = payment-service
```

should map to the same shard under our current configuration.

### Why store the shard index in the payload?

The worker can log the assigned shard and validate that the job is being processed by the expected worker.

This is useful for troubleshooting incorrect routing.

The job data is not the source of truth for routing. The routing policy is. The field is retained as an auditable record of the producer's decision.

---

## 7. Implement Deterministic Partitioning

**File: `src/services/sharding.policy.ts`**

**Action: CREATE this file.**

```ts
import {
  SHARD_COUNT
} from "../queues/sharding.config.js";

export const resolveShardIndex = (
  partitionKey: string,
  shardCount: number = SHARD_COUNT
): number => {
  if (
    typeof partitionKey !== "string" ||
    partitionKey.trim().length === 0
  ) {
    throw new TypeError(
      "Partition key must be a non-empty string"
    );
  }

  if (
    !Number.isInteger(shardCount) ||
    shardCount <= 0
  ) {
    throw new RangeError(
      "Shard count must be a positive integer"
    );
  }

  const normalizedKey = partitionKey.trim();

  let hash = 2166136261;

  for (let index = 0; index < normalizedKey.length; index++) {
    hash ^= normalizedKey.charCodeAt(index);

    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash % shardCount;
};
```

### Understand the hash function

This function uses a 32-bit FNV-1a-style hash over JavaScript UTF-16 code units.

The steps are:

1. Start with a fixed initial hash.
2. Process each character.
3. Mix the character into the hash.
4. Apply a 32-bit multiplication.
5. Convert the result to an unsigned 32-bit integer.
6. Apply modulo to obtain the shard index.

The important property for our application is determinism: the same normalized key produces the same result.

### Example

Conceptually:

```text
"payment-service"
       |
       v
   Hash function
       |
       v
   Unsigned integer
       |
       v
   Integer % 3
       |
       v
   Shard 0, 1, or 2
```

The exact shard depends on the hash implementation and shard count. Do not hardcode an expected mapping without calculating it.

### Why not use JavaScript's built-in object hash?

JavaScript does not expose a standard, stable string-hash function for this purpose.

We need an explicit algorithm so the routing decision remains predictable.

### Why normalize the key?

The following strings should not accidentally represent different partitions if surrounding whitespace is insignificant:

```text
"payment-service"
" payment-service "
```

The policy trims the key before hashing.

It does not convert the key to lowercase. Case sensitivity is a business decision. If your service identifiers are case-insensitive, normalize their case consistently before partitioning.

### Why is this function pure?

It does not access Redis, create queues, or enqueue jobs.

That means we can test the routing algorithm without starting the application or connecting to infrastructure.

---

## 8. Create the Sharded Queues

**File: `src/queues/sharded.queues.ts`**

**Action: CREATE this file.**

```ts
import { Queue } from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

import {
  SHARDED_QUEUE_NAMES
} from "./sharding.config.js";

import type {
  ShardedJobData,
  ShardedJobResult
} from "./jobs/sharded-job.js";

export const shardedQueues = SHARDED_QUEUE_NAMES.map(
  (queueName) =>
    new Queue<ShardedJobData, ShardedJobResult>(
      queueName,
      {
        connection: createBullMQConnection(1),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000
          },
          removeOnComplete: 100,
          removeOnFail: 500
        }
      }
    )
);

export const waitForShardedQueuesReady =
  async (): Promise<void> => {
    await Promise.all(
      shardedQueues.map(
        (queue) => queue.waitUntilReady()
      )
    );
  };

export const closeShardedQueues =
  async (): Promise<void> => {
    await Promise.allSettled(
      shardedQueues.map(
        (queue) => queue.close()
      )
    );
  };
```

### What does this module do?

It creates one BullMQ queue for every entry in `SHARDED_QUEUE_NAMES`.

Instead of manually declaring three queues, we use a configuration array.

If we later change the number of shards, the queue creation logic does not need to be duplicated.

However, changing the shard count requires more than creating extra queues. It can change the partition assignment of existing keys, which we will discuss later.

### Why use the existing connection factory?

Your project already has a shared configuration pattern for BullMQ connections.

Reusing it keeps the Redis connection options consistent across your queue modules.

---

## 9. Implement the Sharded Worker Pool

**File: `src/workers/sharded.worker.ts`**

**Action: CREATE this file.**

```ts
import { Worker } from "bullmq";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import {
  SHARDED_QUEUE_NAMES
} from "../queues/sharding.config.js";

import type {
  ShardedJobData,
  ShardedJobResult
} from "../queues/jobs/sharded-job.js";

import { logger } from "../logging/logger.js";

export const shardedWorkers = SHARDED_QUEUE_NAMES.map(
  (queueName, expectedShardIndex) =>
    new Worker<ShardedJobData, ShardedJobResult>(
      queueName,
      async (job): Promise<ShardedJobResult> => {
        if (
          job.data.shardIndex !== expectedShardIndex
        ) {
          throw new Error(
            `Shard mismatch: expected ${expectedShardIndex}, received ${job.data.shardIndex}`
          );
        }

        const result: ShardedJobResult = {
          partitionKey: job.data.partitionKey,
          shardIndex: expectedShardIndex,
          originalMessage: job.data.message,
          processedMessage: job.data.message
            .trim()
            .toLowerCase(),
          processedAt: new Date().toISOString()
        };

        logger.info("Sharded job completed", {
          jobId: job.id,
          partitionKey: result.partitionKey,
          shardIndex: result.shardIndex,
          queueName
        });

        return result;
      },
      {
        connection: createBullMQConnection(1),
        concurrency: 3
      }
    )
);
```

### How does the worker pool work?

The `map()` creates one worker for each queue name.

For three shards, the process creates:

- Worker 0 consuming `sharded-workload-0`.
- Worker 1 consuming `sharded-workload-1`.
- Worker 2 consuming `sharded-workload-2`.

Each worker has concurrency 3.

The theoretical combined worker concurrency is nine jobs, assuming all three workers are available and jobs are ready.

This does not guarantee nine jobs will always execute simultaneously.

### Why validate the shard index?

If a producer sends a job to the wrong queue, the worker detects the mismatch and fails the job instead of silently processing it under an incorrect partition assignment.

This is a defensive check, not a substitute for correct routing.

### Important limitation

The current workers share one Node.js process.

The queues are separate, but CPU and memory are still shared. For stronger isolation, you may eventually deploy shard workers as separate processes or containers.

---

## 10. Implement the Sharding Service

**File: `src/services/sharded-job.service.ts`**

**Action: CREATE this file.**

```ts
import { randomUUID } from "node:crypto";

import {
  SHARDED_QUEUE_NAMES,
  SHARD_COUNT
} from "../queues/sharding.config.js";

import {
  shardedQueues
} from "../queues/sharded.queues.js";

import type {
  ShardedJobData
} from "../queues/jobs/sharded-job.js";

import {
  resolveShardIndex
} from "./sharding.policy.js";

const MAX_MESSAGE_LENGTH = 500;
const MAX_PARTITION_KEY_LENGTH = 100;

export interface SubmitShardedJobInput {
  partitionKey: string;
  message: string;
}

export interface SubmitShardedJobResult {
  workloadId: string;
  jobId: string;
  partitionKey: string;
  shardIndex: number;
  queueName: string;
}

export const submitShardedJob = async (
  input: SubmitShardedJobInput
): Promise<SubmitShardedJobResult> => {
  if (
    typeof input.partitionKey !== "string" ||
    input.partitionKey.trim().length === 0 ||
    input.partitionKey.length > MAX_PARTITION_KEY_LENGTH
  ) {
    throw new TypeError(
      `Partition key must contain 1 to ${MAX_PARTITION_KEY_LENGTH} characters`
    );
  }

  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError(
      `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
    );
  }

  const partitionKey = input.partitionKey.trim();
  const message = input.message.trim();

  const shardIndex = resolveShardIndex(
    partitionKey,
    SHARD_COUNT
  );

  const queue = shardedQueues[shardIndex];

  if (!queue) {
    throw new Error(
      `No queue configured for shard ${shardIndex}`
    );
  }

  const workloadId = randomUUID();

  const data: ShardedJobData = {
    partitionKey,
    shardIndex,
    message,
    submittedAt: new Date().toISOString()
  };

  const job = await queue.add(
    "process-sharded-job",
    data
  );

  if (!job.id) {
    throw new Error(
      "BullMQ did not return a job ID"
    );
  }

  return {
    workloadId,
    jobId: job.id,
    partitionKey,
    shardIndex,
    queueName: SHARDED_QUEUE_NAMES[shardIndex]
  };
};

export const getShardedJobStatus = async (
  shardIndex: number,
  jobId: string
) => {
  if (
    !Number.isInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= SHARD_COUNT
  ) {
    throw new RangeError(
      "Invalid shard index"
    );
  }

  if (
    typeof jobId !== "string" ||
    jobId.trim().length === 0
  ) {
    throw new TypeError(
      "Job ID must be a non-empty string"
    );
  }

  const queue = shardedQueues[shardIndex];

  if (!queue) {
    throw new Error(
      `No queue configured for shard ${shardIndex}`
    );
  }

  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  return {
    jobId: job.id,
    queueName: SHARDED_QUEUE_NAMES[shardIndex],
    shardIndex,
    partitionKey: job.data.partitionKey,
    state: await job.getState(),
    result: job.returnvalue,
    failedReason: job.failedReason || null
  };
};
```

### Why does the status API require the shard index?

A BullMQ job is stored in a particular queue.

Knowing only the job ID does not tell this service which queue to query.

We could search all queues, but that adds unnecessary work and becomes more expensive as the shard count grows.

Returning the shard index during submission gives the client the information needed for direct lookup.

### Why not calculate the shard index from the message?

The message describes the work. The partition key describes the entity whose jobs should be grouped.

For example, different messages for `payment-service` should map to the same shard when ordering by that service is important.

The partition key must represent a stable business identity.

---

## 11. Create the API Routes

**File: `src/routes/sharded-job.routes.ts`**

**Action: CREATE this file.**

```ts
import { Router } from "express";

import {
  getShardedJobStatus,
  submitShardedJob
} from "../services/sharded-job.service.js";

export const shardedJobRoutes = Router();

const MAX_MESSAGE_LENGTH = 500;
const MAX_PARTITION_KEY_LENGTH = 100;

shardedJobRoutes.post(
  "/",
  async (req, res, next) => {
    try {
      const partitionKey: unknown =
        req.body?.partitionKey;

      const message: unknown =
        req.body?.message;

      if (
        typeof partitionKey !== "string" ||
        partitionKey.trim().length === 0 ||
        partitionKey.length > MAX_PARTITION_KEY_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_PARTITION_KEY",
            message:
              `partitionKey must contain 1 to ${MAX_PARTITION_KEY_LENGTH} characters`
          }
        });
        return;
      }

      if (
        typeof message !== "string" ||
        message.trim().length === 0 ||
        message.length > MAX_MESSAGE_LENGTH
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              `message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
          }
        });
        return;
      }

      const result = await submitShardedJob({
        partitionKey,
        message
      });

      res.status(202).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

shardedJobRoutes.get(
  "/:shardIndex/:jobId",
  async (req, res, next) => {
    try {
      const rawShardIndex = req.params.shardIndex;

      if (!/^(0|[1-9]\d*)$/.test(rawShardIndex)) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_SHARD_INDEX",
            message: "Shard index must be a non-negative integer"
          }
        });
        return;
      }

      const shardIndex = Number(rawShardIndex);

      const result = await getShardedJobStatus(
        shardIndex,
        req.params.jobId
      );

      if (!result) {
        res.status(404).json({
          success: false,
          error: {
            code: "SHARDED_JOB_NOT_FOUND",
            message: "Job was not found in the specified shard"
          }
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      if (error instanceof RangeError) {
        res.status(400).json({
          success: false,
          error: {
            code: "INVALID_SHARD_INDEX",
            message: error.message
          }
        });
        return;
      }

      next(error);
    }
  }
);
```

### Endpoints

Submit a job:

```text
POST /demo/sharded-jobs
```

Check a job's status:

```text
GET /demo/sharded-jobs/:shardIndex/:jobId
```

The status endpoint returns the job state and result when available.

A completed job may eventually disappear because of the queue's retention settings. For durable, long-term tracking, a production platform should persist job or workflow status outside the transient queue record.

---

## 12. Register the Route

**File: `src/app.ts`**

**Action: MODIFY this file. Do not replace the entire file.**

### Step 1: Add the import

```ts
import {
  shardedJobRoutes
} from "./routes/sharded-job.routes.js";
```

### Step 2: Register the route

Add this alongside your existing route registrations:

```ts
app.use(
  "/demo/sharded-jobs",
  shardedJobRoutes
);
```

Preserve the existing middleware order:

1. Request parsing and existing middleware.
2. Application routes.
3. Not-found middleware.
4. Error middleware.

Do not register duplicate JSON parsing middleware or remove any existing routes.

---

## 13. Integrate Worker Lifecycle

Your existing `src/workers.ts` manages the demo, external API, fan-out, pipeline, parent–child, and workload workers.

We will add the sharded workers to the same lifecycle.

### 13.1 Add imports

**File: `src/workers.ts`**

**Action: MODIFY this file by adding the following imports alongside the existing worker imports.**

```ts
import {
  shardedWorkers
} from "./workers/sharded.worker.js";

import {
  closeShardedQueues,
  waitForShardedQueuesReady
} from "./queues/sharded.queues.js";
```

### 13.2 Add readiness checks

Inside your existing `start()` function, add these lines after the existing queue readiness checks.

**File: `src/workers.ts`**

**Action: MODIFY the existing `start()` function.**

```ts
await waitForShardedQueuesReady();

await Promise.all(
  shardedWorkers.map(
    (worker) => worker.waitUntilReady()
  )
);
```

Do not create a second startup function.

### 13.3 Add startup failure cleanup

Your existing startup failure path uses `Promise.allSettled()` to close resources.

Add the following entries to the existing cleanup array.

**File: `src/workers.ts`**

**Action: MODIFY the existing startup failure cleanup array.**

```ts
...shardedWorkers.map(
  (worker) => worker.close()
),
closeShardedQueues()
```

Keep all existing cleanup entries for your other workers, queue events, and queue resources.

The spread operator inserts the individual worker-close promises into the existing array.

### 13.4 Add graceful shutdown

Add the sharded workers to your existing worker-close operation.

**File: `src/workers.ts`**

**Action: MODIFY the existing worker-close array.**

```ts
...shardedWorkers.map(
  (worker) => worker.close()
)
```

After workers have been closed, add queue cleanup to the existing shutdown sequence.

**File: `src/workers.ts`**

**Action: MODIFY the existing shutdown sequence.**

```ts
await closeShardedQueues();
```

The intended order is:

1. Close all workers.
2. Close existing queue events.
3. Close all existing queue resources.
4. Close the sharded queues.
5. Log shutdown completion.

Preserve the existing fan-out, pipeline, parent–child, and workload cleanup calls.

Do not add duplicate queue-close calls if an existing shared cleanup function already owns the same resources.

---

## 14. Unit Tests

We will test the partitioning algorithm without Redis.

The key properties are:

1. The same key always maps to the same shard.
2. Whitespace around a key does not change its assignment.
3. Every result is within the valid shard range.
4. Invalid keys are rejected.
5. Invalid shard counts are rejected.

### 14.1 Create the test file

**File: `tests/sharding.policy.test.ts`**

**Action: CREATE this file.**

```ts
import {
  describe,
  expect,
  it
} from "vitest";

import {
  resolveShardIndex
} from "../src/services/sharding.policy.js";

import {
  SHARD_COUNT
} from "../src/queues/sharding.config.js";

describe("resolveShardIndex", () => {
  it("returns the same shard for the same key", () => {
    const first = resolveShardIndex(
      "payment-service"
    );

    const second = resolveShardIndex(
      "payment-service"
    );

    expect(first).toBe(second);
  });

  it("normalizes surrounding whitespace", () => {
    expect(
      resolveShardIndex(" payment-service ")
    ).toBe(
      resolveShardIndex("payment-service")
    );
  });

  it("returns a valid shard index", () => {
    const keys = [
      "payment-service",
      "authentication-service",
      "notification-service",
      "inventory-service",
      "billing-service"
    ];

    for (const key of keys) {
      const shardIndex = resolveShardIndex(key);

      expect(shardIndex).toBeGreaterThanOrEqual(0);
      expect(shardIndex).toBeLessThan(SHARD_COUNT);
      expect(Number.isInteger(shardIndex)).toBe(true);
    }
  });

  it("rejects an empty partition key", () => {
    expect(() => {
      resolveShardIndex("");
    }).toThrow(TypeError);
  });

  it("rejects a whitespace-only partition key", () => {
    expect(() => {
      resolveShardIndex("   ");
    }).toThrow(TypeError);
  });

  it("rejects a zero shard count", () => {
    expect(() => {
      resolveShardIndex("payment-service", 0);
    }).toThrow(RangeError);
  });

  it("rejects a non-integer shard count", () => {
    expect(() => {
      resolveShardIndex("payment-service", 2.5);
    }).toThrow(RangeError);
  });
});
```

### 14.2 Run the targeted tests

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/sharding.policy.test.ts
```

Expected: all seven tests pass.

### 14.3 Run the complete test suite

**Terminal: PowerShell**

```powershell
npm run test:run
```

Expected: the sharding tests pass and your existing tests remain green.

If a test fails, inspect the specific error before modifying unrelated files.

---

## 15. Build and Run

Run these commands from your project directory:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

### Step 1: Compile TypeScript

**Terminal: PowerShell**

```powershell
npm run build
```

Expected: the project compiles without errors.

If the compiler reports a type mismatch, resolve it against the actual installed BullMQ and TypeScript definitions before proceeding.

### Step 2: Start the API

**Terminal 1: PowerShell**

```powershell
npm run dev
```

Wait until the API is ready.

### Step 3: Start the workers

**Terminal 2: PowerShell**

```powershell
npm run dev:worker
```

Wait for the existing and sharded workers to become ready.

Do not start a second worker process just for the sharded queues.

### Step 4: Verify the worker process

Check the worker logs for startup errors.

If a queue has no worker consuming it, jobs assigned to that queue may remain waiting indefinitely. Readiness checks and queue monitoring help identify this condition.

---

## 16. API Verification

### 16.1 Submit a job

**Terminal: PowerShell**

```powershell
$body = @{
    partitionKey = "payment-service"
    message = "Check payment service health"
} | ConvertTo-Json

$response = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/sharded-jobs" `
    -ContentType "application/json" `
    -Body $body

$response
```

Expected response structure:

```json
{
  "success": true,
  "data": {
    "workloadId": "generated-workload-id",
    "jobId": "generated-job-id",
    "partitionKey": "payment-service",
    "shardIndex": 1,
    "queueName": "sharded-workload-1"
  }
}
```

The IDs and shard index above are illustrative. Your application will calculate the actual shard index.

### 16.2 Submit another job for the same service

**Terminal: PowerShell**

```powershell
$body = @{
    partitionKey = "payment-service"
    message = "Recalculate payment service metrics"
} | ConvertTo-Json

$secondResponse = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/demo/sharded-jobs" `
    -ContentType "application/json" `
    -Body $body

$secondResponse
```

Compare the shard indexes:

**Terminal: PowerShell**

```powershell
$response.data.shardIndex
$secondResponse.data.shardIndex
```

Expected: both values are equal.

This demonstrates deterministic partitioning.

It does **not** guarantee that the two jobs will finish in submission order. A queue can have concurrent workers, and retries can alter execution timing.

If strict per-key execution ordering is required, that needs an additional concurrency and sequencing design.

### 16.3 Check job status

**Terminal: PowerShell**

```powershell
$shardIndex = $response.data.shardIndex
$jobId = $response.data.jobId

Invoke-RestMethod `
    -Method Get `
    -Uri "http://localhost:3000/demo/sharded-jobs/$shardIndex/$jobId"
```

Expected: a response containing the queue name, shard index, job state, and result if the job has completed.

If the job is still waiting or active, query again after processing has had time to complete.

### 16.4 Test an invalid partition key

**Terminal: PowerShell**

```powershell
$body = @{
    partitionKey = "   "
    message = "Check service"
} | ConvertTo-Json

try {
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://localhost:3000/demo/sharded-jobs" `
        -ContentType "application/json" `
        -Body $body
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `400 Bad Request`.

No job should be enqueued.

### 16.5 Test an invalid shard index

**Terminal: PowerShell**

```powershell
try {
    Invoke-RestMethod `
        -Method Get `
        -Uri "http://localhost:3000/demo/sharded-jobs/99/fake-job-id"
}
catch {
    $_.Exception.Message
}
```

Expected: HTTP `400 Bad Request`.

A shard index outside the configured range must not be used to query a queue.

---

## 17. Intentional Break → Understand → Fix

### Break 1: Make partitioning nondeterministic

**File: `src/services/sharding.policy.ts`**

Temporarily replace the final return statement:

```ts
return hash % shardCount;
```

with:

```ts
return Math.floor(Math.random() * shardCount);
```

Run the targeted tests.

**Terminal: PowerShell**

```powershell
npm run test:run -- tests/sharding.policy.test.ts
```

Expected: the determinism test fails.

### Understand the failure

If the same service maps to different shards on different requests, its jobs will be distributed across multiple queues.

That breaks the partitioning contract.

For a workload that requires per-entity grouping, nondeterministic routing is a correctness problem, not just a performance problem.

### Fix 1

Restore:

```ts
return hash % shardCount;
```

Run the targeted tests again.

Expected: all seven tests pass.

### Break 2: Use the wrong shard count in the producer

**File: `src/services/sharded-job.service.ts`**

Temporarily change the call so that it uses a different shard count than the queue configuration:

```ts
const shardIndex = resolveShardIndex(
  partitionKey,
  2
);
```

This will route jobs only to shard indexes 0 and 1, leaving shard 2 unused by this producer.

The application may still compile and process jobs. That is why a routing mismatch can be difficult to detect from compilation alone.

### Understand the failure

The producer's partitioning configuration and the queue configuration must agree.

If the producer calculates shard indexes using one scheme while workers or other producers use another, workload distribution becomes inconsistent.

### Fix 2

Restore the shared configuration:

```ts
const shardIndex = resolveShardIndex(
  partitionKey,
  SHARD_COUNT
);
```

Use the single configuration constant rather than hardcoding a separate number.

### Final verification

**Terminal: PowerShell**

```powershell
npm run build
npm run test:run
```

Then submit two jobs with the same partition key.

Verify that both return the same shard index and are processed by the corresponding worker.

---

## 18. Production Trade-offs

### 18.1 Changing the shard count changes the partition mapping

Our current strategy uses:

```text
hash(key) % shardCount
```

Suppose the shard count changes from three to four.

A key that previously mapped to shard 1 may now map to shard 3.

This creates a migration problem:

- Old jobs may remain in the original queue.
- New jobs may be routed to another queue.
- Jobs for the same entity can temporarily exist in different shards.
- Per-key ordering may be broken across the migration.

Do not casually change the shard count in production if partition affinity matters.

A migration plan may require versioned routing, draining old queues, or a controlled transition.

### 18.2 Consider consistent hashing

Modulo hashing is simple, but changing the number of shards can remap many keys.

Consistent hashing can reduce the number of keys that move when the set of shards changes.

However, it introduces additional complexity, such as a hash ring or virtual nodes.

Do not adopt consistent hashing unless the operational benefits justify that complexity.

### 18.3 A hot key can still create a hot shard

Suppose `payment-service` produces 80% of all jobs.

All those jobs map to one shard.

Even if the other two shards are nearly idle, the hot shard may accumulate a large backlog.

Potential solutions include:

- Increasing worker capacity for the hot shard.
- Separating the dominant workload into its own queue.
- Choosing a finer-grained partition key when business ordering allows it.
- Splitting the workload into independently processable subpartitions.

Changing the partition key must be a deliberate business decision.

If all jobs for one entity must remain ordered, splitting that entity across shards can violate the requirement.

### 18.4 Shards do not provide exactly-once processing

BullMQ jobs can be retried.

A worker may perform a side effect and then fail before BullMQ records successful completion.

The job can execute again.

Use idempotency controls for operations that must not be repeated, especially when updating PostgreSQL or calling external APIs.

### 18.5 Sharding Redis queues is not Redis Cluster sharding

This lecture creates multiple BullMQ queues on your existing Redis deployment.

That is **logical queue sharding**, not a guarantee that data is distributed across separate Redis servers.

All queues may still compete for the same Redis CPU, memory, network, and persistence resources.

If Redis itself becomes the bottleneck, adding queue names alone will not solve the infrastructure problem.

### 18.6 Worker processes may need separate deployment

Our sharded workers currently run in the same worker process.

For stronger isolation and independent scaling, you can deploy shard workers in separate processes or containers.

That requires deployment configuration, independent health checks, resource limits, and a clear shutdown strategy.

### 18.7 Monitor each shard independently

Useful metrics include:

- Waiting jobs per shard.
- Active jobs per shard.
- Oldest waiting-job age.
- Completed and failed jobs.
- Retry counts.
- Processing duration.
- Worker availability.
- Redis latency and memory.

Aggregate queue depth can hide a hot shard.

Your existing queue-monitoring work provides a foundation for adding per-shard metrics.

### 18.8 Sharding is not always necessary

A single well-configured queue can support substantial workloads.

Before introducing more shards, measure the bottleneck.

If the main limitation is a slow external API, CPU-heavy processing, database contention, or inadequate worker capacity, sharding the queue may not address the root cause.

---

## 19. Final Folder Structure

The following is a focused view of the files added in this lecture.

```text
production-intelligence-platform/
├── src/
│   ├── queues/
│   │   ├── jobs/
│   │   │   └── sharded-job.ts
│   │   ├── sharding.config.ts
│   │   └── sharded.queues.ts
│   ├── services/
│   │   ├── sharding.policy.ts
│   │   └── sharded-job.service.ts
│   ├── workers/
│   │   └── sharded.worker.ts
│   ├── routes/
│   │   └── sharded-job.routes.ts
│   ├── app.ts
│   └── workers.ts
└── tests/
    └── sharding.policy.test.ts
```

Your existing demo, external API, workload, fan-out, pipeline, and parent–child files remain in place.

---

## 20. Success Criteria

Before considering this lecture complete, verify each item.

- [ ] The shard count and queue names are centralized.
- [ ] The job contract contains a partition key and shard index.
- [ ] The partitioning function is deterministic.
- [ ] Invalid keys and shard counts are rejected.
- [ ] The same partition key maps to the same shard.
- [ ] Three BullMQ queues are created.
- [ ] Each queue has a corresponding worker.
- [ ] Workers validate the expected shard index.
- [ ] The API returns the shard index, queue name, and job ID.
- [ ] The status endpoint queries the specified shard.
- [ ] All sharded queues participate in readiness checks.
- [ ] All sharded workers participate in startup failure cleanup.
- [ ] All sharded workers and queues participate in graceful shutdown.
- [ ] The targeted unit tests pass.
- [ ] `npm run build` passes.
- [ ] `npm run test:run` passes.
- [ ] Both intentional-break exercises have been fixed and re-tested.
- [ ] Two jobs with the same partition key map to the same shard.

---

## Module 2 — Completion Review

**Module 2: Advanced Queue Patterns is now complete once you have verified the implementation and all success criteria above.**

You have covered the key patterns for building more capable background-processing systems:

- Multiple queues and queue routing.
- Fan-out and fan-in.
- Job pipelines and dependencies.
- Batch jobs and bulk enqueue.
- Parent–child orchestration.
- Workload isolation.
- Queue sharding and deterministic partitioning.

These are foundational patterns. Production readiness still depends on testing, observability, failure handling, idempotency, capacity planning, and deployment design.

### Next: Module 3 — Distributed Systems

The next module moves beyond individual queues into coordination and correctness across distributed processes.

The planned topics include:

1. At-least-once vs. exactly-once processing.
2. Distributed locks.
3. Redlock and its trade-offs.
4. Leader election.
5. Clock drift and time-related failures.
6. Race conditions.
7. Event-driven architecture.
8. Saga pattern.
9. Transactional Outbox pattern.

**Do not start Module 3 until this lecture builds, passes tests, and works with your local Redis and worker processes.**