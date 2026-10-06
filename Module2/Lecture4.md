# Module 2 — Lecture 4

# BullMQ Architecture & First Queue

> **Project:** Production Intelligence & Incident Platform
>
> **Stack:** Node.js + TypeScript + Express + PostgreSQL + Redis + BullMQ
>
> **Development method:** Build → Test → Break → Fix → Verify
>
> **AI:** Not used

---

## 1. Lecture Objective

Until now, Redis is simply a dependency of our application.

In this lecture, we introduce **BullMQ**.

We will build the smallest complete background-job pipeline:

```
HTTP Request
     │
     ▼
Producer
     │
     ▼
BullMQ Queue
     │
     ▼
Redis
     │
     ▼
Worker
     │
     ▼
Job Processing
```

BullMQ provides the `Queue` abstraction for adding jobs and the `Worker` abstraction for processing them. Jobs can remain in the queue even when a worker is temporarily unavailable.

### We will NOT implement yet

Do **not** add these in Lecture 4:

-  retries
-  exponential backoff
-  delayed jobs
-  priorities
-  concurrency
-  dead-letter queues
-  job dependencies
-  flows
-  rate limiting
-  scheduled jobs
-  QueueEvents
-  distributed workers
-  job idempotency

Those are later lectures.

Our goal is to understand one thing perfectly:

> **How does a job travel from producer → Redis/BullMQ → worker → completion?**

---

# 2. Architecture We Are Building

Our application will eventually look like this:

```
                         ┌──────────────────────┐
                         │       Express        │
                         │        API           │
                         └──────────┬───────────┘
                                    │
                                    │ addJob()
                                    ▼
                         ┌──────────────────────┐
                         │       Producer      │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │       BullMQ         │
                         │        Queue         │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │        Redis         │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │       BullMQ         │
                         │        Worker        │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │   Job Processor      │
                         └──────────────────────┘
```

A `Queue` is essentially the interface through which producers add jobs. Workers consume those jobs and mark them completed or failed.

---

# 3. Important Redis Architecture Decision

We already have this Redis client:

### `src/redis/client.ts`

```
import Redis from "ioredis";

import { env } from "../config/env.js";

export const redis =
  new Redis({
    host:
      env.redis.host,

    port:
      env.redis.port,

    lazyConnect: true,

    connectTimeout:
      env.redis.connectTimeoutMs,

    maxRetriesPerRequest: null,

    retryStrategy: (
      times: number
    ): number => {
      const delay =
        Math.min(
          times * 500,
          5000
        );

      return delay;
    }
  });
```

We are **not going to blindly pass this existing application Redis client into BullMQ Queue and Worker**.

Why?

Because producers and workers have different Redis connection requirements.

BullMQ's documentation specifically distinguishes Queue connections from Worker connections. Producer-side queue operations should normally fail relatively quickly when Redis is unavailable, while worker connections are expected to remain persistent. Workers using ioredis require `maxRetriesPerRequest: null`.

Therefore we will create **dedicated BullMQ connection factories**.

---

# 4. Install BullMQ

## Step 4.1 — Install dependency

### Terminal

```
npm install bullmq
```

BullMQ's official installation is simply:

```
npm install bullmq
```

---

## Step 4.2 — Verify installation

Run:

```
npm ls bullmq
```

You should see BullMQ installed.

Also verify:

```
npm run build
```

At this point we have not written any BullMQ code yet.

---

# 5. Create BullMQ Configuration

We need a dedicated configuration module.

### Create:

```
src/queues/bullmq.connection.ts
```

### `src/queues/bullmq.connection.ts`

```
import {
  env
} from "../config/env.js";

export const createBullMQConnection = (
  maxRetriesPerRequest: number | null
) => {
  return {
    host: env.redis.host,

    port: env.redis.port,

    connectTimeout:
      env.redis.connectTimeoutMs,

    maxRetriesPerRequest,

    retryStrategy: (
      times: number
    ): number => {
      return Math.min(
        times * 500,
        5000
      );
    }
  };
};

// Need to update in doc
```

---

# 6. Why We Created a Factory

We don't want this:

```
One Redis connection
       │
       ├── application cache
       ├── health checks
       ├── producer
       └── worker
```

because these workloads have different requirements.

Instead:

```
                    Redis
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
 Application      Producer        Worker
 Redis Client     Connection      Connection
```

BullMQ itself manages the Redis connections it needs internally, and workers may require dedicated blocking connections.

This separation will become increasingly important when we introduce workers as separate processes.

---

# 7. Create Our First Queue

For this lecture, we don't want to introduce a business queue prematurely.

We'll create a simple learning queue:

```
demo-job
```

### Create:

```
src/queues/demo.queue.ts
```

### `src/queues/demo.queue.ts`

```
import {
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

export const DEMO_QUEUE_NAME =
  "demo-job";

export const demoQueue =
  new Queue(
    DEMO_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(
          1
        )
    }
  );
```

---

# 8. Understand the Queue

This line:

```
new Queue(
  DEMO_QUEUE_NAME,
  ...
)
```

creates the BullMQ queue abstraction.

The queue itself does not process jobs.

Think:

```
Queue
  =
"Place where jobs wait"
```

The worker does the actual processing.

```
Queue  → stores/manages jobs

Worker → processes jobs
```

A worker is the component responsible for executing the job processor.

---

# 9. Create a Strongly Typed Job

TypeScript is one of the reasons we're building this project with TypeScript.

Create:

```
src/queues/jobs/demo.job.ts
```

### `src/queues/jobs/demo.job.ts`

```
export interface DemoJobData {
  message: string;
}
```

Our job payload is now:

```
{
  message: "Hello BullMQ"
}
```

but TypeScript knows the expected shape.

---

# 10. Create the Producer

The producer's responsibility is simple:

> Add a job to the queue.

### Create:

```
src/queues/producers/demo.producer.ts
```

### `src/queues/producers/demo.producer.ts`

```
import {
  demoQueue
} from "../demo.queue.js";

import type {
  DemoJobData
} from "../jobs/demo.job.js";

export const addDemoJob =
  async (
    data: DemoJobData
  ): Promise<string> => {

    const job =
      await demoQueue.add(
        "demo-job",
        data
      );

    if (
      job.id === undefined
    ) {
      throw new Error(
        "BullMQ job ID was not generated"
      );
    }

    return job.id;
  };
```

---

# 11. Understand `queue.add()`

This:

```
await demoQueue.add(
  "demo-job",
  data
);
```

contains two important pieces.

### Job name

```
demo-job
```

### Job data

```
{
  "message": "Hello BullMQ"
}
```

Conceptually:

```
Queue.add()
     │
     ├── Job name
     │
     └── Job data
```

BullMQ stores the job in Redis so a worker can process it later. The worker does not have to be running at the exact moment the job is added.

---

# 12. Create the Worker

Now we create the component that processes the job.

### Create:

```
src/workers/demo.worker.ts
```

### `src/workers/demo.worker.ts`

```
import {
  Worker,
  Job
} from "bullmq";

import {
  DEMO_QUEUE_NAME
} from "../queues/demo.queue.js";

import {
  createBullMQConnection
} from "../queues/bullmq.connection.js";

import type {
  DemoJobData
} from "../queues/jobs/demo.job.js";

export const demoWorker =
  new Worker<
    DemoJobData,
    {
      processed: boolean;
    }
  >(
    DEMO_QUEUE_NAME,

    async (
      job: Job<DemoJobData>
    ) => {

      console.log(
        `[DemoWorker] Processing job ${job.id}`
      );

      console.log(
        `[DemoWorker] Message: ${job.data.message}`
      );

      return {
        processed: true
      };
    },

    {
      connection:
        createBullMQConnection(
          null
        )
    }
  );

demoWorker.on(
  "completed",
  (job) => {

    console.log(
      `[DemoWorker] Job ${job.id} completed`
    );
  }
);

demoWorker.on(
  "failed",
  (
    job,
    error
  ) => {

    console.error(
      `[DemoWorker] Job ${job?.id ?? "unknown"} failed`,
      error
    );
  }
);

demoWorker.on(
  "error",
  (error) => {

    console.error(
      "[DemoWorker] Worker error",
      error
    );
  }
);
```

---

# 13. Why Worker Uses `null`

Notice this:

```
createBullMQConnection(null)
```

which produces:

```
maxRetriesPerRequest: null
```

This is intentional for a long-running worker.

BullMQ's production guidance explains that Worker connections should be able to keep retrying while Redis is temporarily unavailable.

Conceptually:

```
Producer
   ↓
Redis unavailable
   ↓
Fail relatively quickly
   ↓
HTTP caller can retry

Worker
   ↓
Redis unavailable
   ↓
Keep connection alive
   ↓
Redis comes back
   ↓
Continue processing
```

This distinction will become extremely important later.

---

# 14. Worker Lifecycle

Our worker starts processing when it is instantiated.

BullMQ workers begin consuming jobs when created unless configured otherwise.

Therefore:

```
export const demoWorker =
  new Worker(...)
```

means:

```
Worker created
      ↓
Connect Redis
      ↓
Listen for jobs
      ↓
Job arrives
      ↓
Processor executes
```

---

# 15. We Need a Worker Entry Point

Our API server should not be responsible for running the worker yet.

Create a separate process entry point.

### Create:

```
src/workers.ts
```

### `src/workers.ts`

```
import {
  demoWorker
} from "./workers/demo.worker.js";

console.log(
  "Worker process started"
);

const shutdown =
  async (
    signal: string
  ): Promise<void> => {

    console.log(
      `Worker shutdown started: ${signal}`
    );

    await demoWorker.close();

    console.log(
      "Worker shutdown completed"
    );
  };

process.on(
  "SIGINT",
  () => {
    void shutdown("SIGINT");
  }
);

process.on(
  "SIGTERM",
  () => {
    void shutdown("SIGTERM");
  }
);
```

---

# 16. Why Separate Worker Process?

Eventually our architecture will be:

```
                ┌─────────────────┐
                │       API       │
                │                 │
                │ Express         │
                │ REST            │
                │ Producers       │
                └────────┬────────┘
                         │
                         ▼
                     ┌───────┐
                     │ Redis │
                     └───┬───┘
                         │
                         ▼
                ┌─────────────────┐
                │     Worker      │
                │                 │
                │ Background jobs │
                └─────────────────┘
```

This is much closer to a production architecture than putting everything inside:

```
server.ts
```

Eventually we can run:

```
API replicas:
    API 1
    API 2
    API 3

Workers:
    Worker 1
    Worker 2
    Worker 3
```

BullMQ supports multiple workers consuming the same queue.

But **we are not scaling them yet**.

---

# 17. Add npm Scripts

### File

```
package.json
```

Modify the `scripts` section.

Keep your existing scripts and add:

```
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "dev:worker": "tsx watch src/workers.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "start:worker": "node dist/workers.js",
    "test": "vitest",
    "test:run": "vitest run",
    "migrate": "tsx src/database/migrate.ts"
  }
}
```

The important additions are:

```
dev:worker
start:worker
```

---

# 18. Build

Run:

```
npm run build
```

Expected:

```
TypeScript compilation successful
```

If you get an error, **stop here** and fix it before continuing.

Do not continue with a broken build.

---

# 19. Check Generated Files

After:

```
npm run build
```

you should have:

```
dist/
├── queues/
│   ├── bullmq.connection.js
│   ├── demo.queue.js
│   ├── jobs/
│   │   └── demo.job.js
│   └── producers/
│       └── demo.producer.js
│
├── workers/
│   └── demo.worker.js
│
└── workers.js
```

---

# 20. Start Redis

Make sure Redis is running:

```
docker compose start redis
```

Then:

```
docker compose ps
```

Redis should become:

```
Up ... (healthy)
```

Verify:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

---

# 21. Start the Worker

Open a **new PowerShell terminal**.

Run:

```
npm run dev:worker
```

Expected:

```
Worker process started
```

Keep this terminal running.

---

# 22. We Need a Way to Produce a Job

For now, we will create a temporary development route.

We don't want to hide job creation inside some unrelated business endpoint.

### Create:

```
src/routes/demo-queue.routes.ts
```

### `src/routes/demo-queue.routes.ts`

```
import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

const router =
  Router();

router.post(
  "/demo/jobs",
  async (
    _req,
    res,
    next
  ) => {

    try {

      const jobId =
        await addDemoJob({
          message:
            "Hello from Production Intelligence Platform"
        });

      res.status(202).json({
        success: true,
        data: {
          jobId
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

export default router;
```

---

# 23. Register the Route

Open:

```
src/app.ts
```

Find your existing route registrations.

Add:

```
import demoQueueRoutes
  from "./routes/demo-queue.routes.js";
```

Then register:

```
app.use(
  demoQueueRoutes
);
```

### Important

Do not remove any existing routes.

Your application should now have:

```
/health/live
/health/ready
/health
/incidents
...
/demo/jobs
```

---

# 24. Build Again

```
npm run build
```

Then restart your API development server if you're using Docker.

Because our API runs inside Docker, rebuild the API image:

```
docker compose build api
```

Then:

```
docker compose up -d --force-recreate api
```

Verify:

```
docker compose ps
```

---

# 25. Start Worker

In your worker terminal:

```
npm run dev:worker
```

You should see:

```
Worker process started
```

---

# 26. Add First Job

Open another PowerShell terminal.

Run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  http://localhost:3000/demo/jobs
```

Expected:

```
{
  "success": true,
  "data": {
    "jobId": "1"
  }
}
```

The exact job ID may be different.

---

# 27. Observe Worker

Go to the worker terminal.

You should see something similar to:

```
Worker process started

[DemoWorker] Processing job 1

[DemoWorker] Message:
Hello from Production Intelligence Platform

[DemoWorker] Job 1 completed
```

This is our first complete background job.

---

# 28. Understand What Just Happened

The complete flow was:

```
POST /demo/jobs
       │
       ▼
demo-queue.routes.ts
       │
       ▼
addDemoJob()
       │
       ▼
demoQueue.add()
       │
       ▼
BullMQ
       │
       ▼
Redis
       │
       ▼
demoWorker
       │
       ▼
processor()
       │
       ▼
completed
```

That is the foundation for everything we're going to build later.

---

# 29. Very Important: API Did NOT Process the Job

The API did:

```
Receive HTTP request
       ↓
Create job
       ↓
Store job in Redis
       ↓
Return HTTP 202
```

The worker did:

```
Receive job
       ↓
Process job
       ↓
Return result
       ↓
BullMQ marks job completed
```

This separation is the whole point of background processing.

---

# 30. Why HTTP 202?

We used:

```
res.status(202)
```

rather than:

```
res.status(200)
```

because the operation has been **accepted for processing**, but the background work has not necessarily completed before the HTTP response.

Conceptually:

```
POST
 ↓
Job accepted
 ↓
202 Accepted
 ↓
Worker processes asynchronously
```

The client doesn't need to wait for the background operation.

---

# 31. Inspect Redis

Run:

```
docker compose exec redis redis-cli
```

Then:

```
KEYS bull:demo-job:*
```

You may see BullMQ-related keys depending on the current job state and cleanup behavior.

Exit:

```
exit
```

### Important

Don't rely on `KEYS` in production for large Redis databases.

We are using it here purely for learning and inspection.

Later we'll use safer inspection patterns.

---

# 32. Inspect Queue From Node

We can also inspect jobs through BullMQ rather than directly manipulating Redis.

Create:

```
src/queues/demo.inspect.ts
```

### `src/queues/demo.inspect.ts`

```
import {
  demoQueue
} from "./demo.queue.js";

const counts =
  await demoQueue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed"
  );

console.log(
  counts
);

await demoQueue.close();
```

For now this is a learning utility.

We will not turn it into a production endpoint.

---

# 33. Run Inspection

First build:

```
npm run build
```

Then:

```
node dist/queues/demo.inspect.js
```

You should see counts similar to:

```
{
  waiting: 0,
  active: 0,
  completed: 1,
  failed: 0
}
```

Exact counts depend on previous jobs.

---

# 34. Important BullMQ Mental Model

Think of the queue as a state machine:

```
             ┌──────────┐
             │ WAITING  │
             └────┬─────┘
                  │
                  ▼
             ┌──────────┐
             │  ACTIVE  │
             └────┬─────┘
                  │
          ┌───────┴────────┐
          │                │
          ▼                ▼
     ┌───────────┐   ┌──────────┐
     │ COMPLETED │   │  FAILED  │
     └───────────┘   └──────────┘
```

We are intentionally **not implementing the failure/retry side deeply yet**.

That comes later.

---

# 35. Test Worker Without Running It

This is an important experiment.

### Stop the worker.

In the worker terminal:

```
Ctrl + C
```

Now the worker is gone.

Verify:

```
docker compose ps
```

The worker isn't a Docker service yet; it's simply your local Node process.

---

# 36. Add a Job While Worker Is Down

Run:

```
Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  http://localhost:3000/demo/jobs
```

You should receive:

```
{
  "success": true,
  "data": {
    "jobId": "2"
  }
}
```

But there should be **no worker output**, because the worker isn't running.

This demonstrates something fundamental:

```
Producer
   │
   ▼
Redis
   │
   ▼
WAITING
```

The job doesn't disappear.

---

# 37. Start Worker Again

Run:

```
npm run dev:worker
```

You should see:

```
Worker process started
```

Then shortly afterward:

```
[DemoWorker] Processing job 2
```

and:

```
[DemoWorker] Job 2 completed
```

This proves:

> **The queue decouples job creation from job execution.**

The producer and worker do not have to be alive at exactly the same moment.

BullMQ explicitly supports jobs being added while workers are not running; once a worker connects, it can process waiting jobs.

---

# 38. BREAK TEST — Kill Worker During Processing

Now we intentionally introduce failure.

Modify:

```
src/workers/demo.worker.ts
```

temporarily.

Inside the processor:

```
console.log(
  `[DemoWorker] Processing job ${job.id}`
);

await new Promise(
  (resolve) =>
    setTimeout(
      resolve,
      10000
    )
);

console.log(
  `[DemoWorker] Finished processing job ${job.id}`
);
```

This gives us a 10-second processing window.

---

# 39. Build Worker

```
npm run build
```

Start worker:

```
npm run dev:worker
```

Then create a job:

```
Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  http://localhost:3000/demo/jobs
```

Worker should show:

```
[DemoWorker] Processing job 3
```

Immediately press:

```
Ctrl + C
```

We intentionally killed the worker while processing.

---

# 40. What Did We Learn?

We have now discovered a major distributed-systems concept:

```
Job processing
      ≠
HTTP request lifecycle
```

The worker can disappear.

The queue remains.

Redis remains.

BullMQ maintains job state.

Later lectures will teach what happens to interrupted jobs, stalled jobs, retries, and failures.

BullMQ workers move successful jobs to completed and failed processing to failed; stalled jobs can be returned to waiting for another worker depending on the stall rules.

**Do not implement those mechanisms manually yet.**

---

# 41. Restore the Worker

Remove the temporary 10-second delay.

### `src/workers/demo.worker.ts`

Restore the processor to:

```
async (
  job: Job<DemoJobData>
) => {

  console.log(
    `[DemoWorker] Processing job ${job.id}`
  );

  console.log(
    `[DemoWorker] Message: ${job.data.message}`
  );

  return {
    processed: true
  };
}
```

Build:

```
npm run build
```

Start:

```
npm run dev:worker
```

---

# 42. Test Redis Failure

We already learned Redis failure behavior in the previous lecture.

Now observe how BullMQ behaves.

### Stop Redis

```
docker compose stop redis
```

Worker logs may show Redis connection/reconnection errors.

That is expected.

The worker is a long-lived background process.

Start Redis again:

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

The worker should reconnect.

This persistent-worker behavior is exactly why worker Redis connections are configured differently from request-path producer connections.

---

# 43. Testing Checklist

## Test 1 — Build

```
npm run build
```

Expected:

```
PASS
```

---

## Test 2 — Redis

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

---

## Test 3 — Worker starts

```
npm run dev:worker
```

Expected:

```
Worker process started
```

---

## Test 4 — Producer

```
Invoke-WebRequest `
  -UseBasicParsing `
  -Method POST `
  http://localhost:3000/demo/jobs
```

Expected:

```
202
```

---

## Test 5 — Worker receives job

Expected:

```
[DemoWorker] Processing job ...
```

---

## Test 6 — Worker completes job

Expected:

```
[DemoWorker] Job ... completed
```

---

## Test 7 — Worker stopped

Stop worker:

```
Ctrl + C
```

Add another job.

Expected:

```
HTTP → 202
```

but no worker processing.

---

## Test 8 — Worker restart

```
npm run dev:worker
```

Expected:

```
waiting job
     ↓
worker receives it
     ↓
completed
```

---

## Test 9 — Redis failure

```
docker compose stop redis
```

Worker should lose Redis connectivity.

---

## Test 10 — Redis recovery

```
docker compose start redis
```

Then:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

Worker should reconnect.

---

# 44. Full Test Suite

Run:

```
npm run test:run
```

Then:

```
npm run build
```

Both must pass before moving forward.

---

# 45. Production Architecture After Lecture 4

We now have:

```
                         ┌──────────────────┐
                         │      Client      │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │    Express API   │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Producer     │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │      BullMQ      │
                         │      Queue       │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │      Redis       │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Worker       │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Background Job   │
                         └──────────────────┘
```

---

# 46. Final Folder Structure

After this lecture:

```
src/
├── config/
│   ├── config.types.ts
│   ├── env.ts
│   └── rate-limit.ts
│
├── controllers/
│   ├── health.controller.ts
│   └── incident.controller.ts
│
├── database/
│   ├── migrations/
│   ├── health.ts
│   ├── migrate.ts
│   ├── pool.ts
│   └── transaction.ts
│
├── domain/
│
├── errors/
│
├── logging/
│
├── middleware/
│
├── redis/
│   ├── client.ts
│   ├── health.ts
│   └── lifecycle.ts
│
├── repositories/
│
├── routes/
│   ├── health.routes.ts
│   ├── incident.routes.ts
│   └── demo-queue.routes.ts
│
├── queues/
│   ├── bullmq.connection.ts
│   ├── demo.queue.ts
│   ├── demo.inspect.ts
│   ├── jobs/
│   │   └── demo.job.ts
│   └── producers/
│       └── demo.producer.ts
│
├── services/
│   ├── incident.service.ts
│   └── redis.service.ts
│
├── server/
│   ├── lifecycle.ts
│   └── shutdown.ts
│
├── types/
│
├── utils/
│
├── validators/
│
├── workers/
│   └── demo.worker.ts
│
├── app.ts
├── container.ts
├── server.ts
└── workers.ts
```

---

# 47. What We Learned

You should now be able to explain these without looking at the code:

### Queue

> A BullMQ Queue is the producer-side abstraction used to add and manage jobs.

### Producer

> The producer creates jobs and places them into the queue.

### Worker

> The worker consumes jobs and executes the processing function.

### Redis

> Redis is the persistent backend BullMQ uses to store and coordinate queue/job state.

### Job

> A job contains a name, data, and BullMQ-managed state.

### Background processing

```
Request
   ↓
Create job
   ↓
Return 202
   ↓
Worker processes later
```

### Decoupling

```
Producer ≠ Worker
```

They can run independently.

---

# 48. What We Deliberately Did NOT Learn Yet

Do not start implementing these yourself yet:

```
Retries
    ↓
Backoff
    ↓
Delayed jobs
    ↓
Priorities
    ↓
Concurrency
    ↓
Rate limiting
    ↓
Dead-letter queue
    ↓
Queue events
    ↓
Flows
```

We will introduce them one at a time.

---

# 49. Lecture Success Criteria

Lecture 4 is complete only when all of these are true:

- `bullmq` installed
-  TypeScript build succeeds
-  Redis running
-  BullMQ Queue created
-  Typed job created
-  Producer created
-  Worker created
-  Worker runs as separate process
-  API creates a job
-  Worker receives job
-  Worker completes job
-  Worker can be stopped
-  Job can remain waiting
-  Worker restart processes waiting job
-  Redis failure tested
-  Redis recovery tested
- `npm run test:run` passes
- `npm run build` passes

---

# 50. Most Important Mental Model

Memorize this:

```
                 PRODUCER
                    │
                    │ add()
                    ▼
              ┌───────────┐
              │   QUEUE   │
              └─────┬─────┘
                    │
                    ▼
                 REDIS
                    │
                    │ consume
                    ▼
              ┌───────────┐
              │  WORKER   │
              └─────┬─────┘
                    │
                    ▼
                PROCESSOR
                    │
             ┌──────┴──────┐
             ▼             ▼
         SUCCESS         ERROR
             │             │
             ▼             ▼
        COMPLETED        FAILED
```

**This is the foundation for the rest of Module 2.**
