# Production Intelligence & Incident Platform

# Module 2 — Lecture 1: Redis Fundamentals & Production Redis Setup

> **Development method**
>
> **Understand → Design → Implement → Run → Test → Intentionally Break → Fix → Verify → Move Forward**

---

# Table of Contents

1. [Lecture Objective](#1-lecture-objective)
2. [Why Redis Exists in Our Platform](#2-why-redis-exists-in-our-platform)
3. [What Redis Is](#3-what-redis-is)
4. [Redis vs PostgreSQL](#4-redis-vs-postgresql)
5. [What We Will NOT Build Yet](#5-what-we-will-not-build-yet)
6. [Target Architecture](#6-target-architecture)
7. [Step 1 — Install the Redis Client](#7-step-1--install-the-redis-client)
8. [Step 2 — Update Environment Configuration](#8-step-2--update-environment-configuration)
9. [Step 3 — Update Configuration Types](#9-step-3--update-configuration-types)
10. [Step 4 — Update Environment Loader](#10-step-4--update-environment-loader)
11. [Step 5 — Add Redis to Docker Compose](#11-step-5--add-redis-to-docker-compose)
12. [Step 6 — Create Redis Client](#12-step-6--create-redis-client)
13. [Step 7 — Create Redis Lifecycle](#13-step-7--create-redis-lifecycle)
14. [Step 8 — Connect Redis During Application Startup](#14-step-8--connect-redis-during-application-startup)
15. [Step 9 — Close Redis During Shutdown](#15-step-9--close-redis-during-shutdown)
16. [Step 10 — Verify TypeScript](#16-step-10--verify-typescript)
17. [Step 11 — Start Redis](#17-step-11--start-redis)
18. [Step 12 — Verify Redis Container](#18-step-12--verify-redis-container)
19. [Step 13 — Verify Redis CLI](#19-step-13--verify-redis-cli)
20. [Step 14 — Verify Application → Redis](#20-step-14--verify-application--redis)
21. [Step 15 — Test Basic Redis Operations](#21-step-15--test-basic-redis-operations)
22. [Step 16 — Understand Redis Data Types](#22-step-16--understand-redis-data-types)
23. [Step 17 — Intentional Failure: Stop Redis](#23-step-17--intentional-failure-stop-redis)
24. [Step 18 — Recover Redis](#24-step-18--recover-redis)
25. [Step 19 — Verify Graceful Redis Shutdown](#25-step-19--verify-graceful-redis-shutdown)
26. [Step 20 — Run the Complete Test Suite](#26-step-20--run-the-complete-test-suite)
27. [Common Mistakes](#27-common-mistakes)
28. [Production Improvements](#28-production-improvements)
29. [Redis Rules We Establish](#29-redis-rules-we-establish)
30. [Final Architecture](#30-final-architecture)
31. [Final Folder Structure](#31-final-folder-structure)
32. [Verification Checklist](#32-verification-checklist)
33. [Assignment](#33-assignment)
34. [Success Criteria](#34-success-criteria)
35. [Next Lecture](#35-next-lecture)

---

# 1. Lecture Objective

Module 1 gave us a reliable HTTP + PostgreSQL foundation.

Now we introduce:

```text
Redis
```
But we are **not** introducing BullMQ yet.

The goal of this lecture is to understand and implement:


```
Node.js
   │
   ▼
ioredis
   │
   ▼
Redis
   │
   ▼
Docker
```

By the end of this lecture, our application must be able to:

-  start Redis
-  connect to Redis
-  verify the connection
-  execute Redis commands
-  detect Redis connection failures
-  recover after Redis restarts
-  close the Redis connection during application shutdown
-  run Redis inside Docker Compose
-  keep Redis configuration centralized
-  keep Redis credentials/configuration outside source code

---

# 2. Why Redis Exists in Our Platform

Our current architecture is:


```
Client
   │
   ▼
API
   │
   ▼
PostgreSQL
```

PostgreSQL is our durable system of record.

But later our platform will need operations such as:


```
background jobs
temporary state
job coordination
distributed locks
rate limiting
caching
queue metadata
worker coordination
```

These are workloads where Redis becomes useful.

Eventually:


```
                         ┌──────────────┐
                         │     API      │
                         └──────┬───────┘
                                │
                 ┌──────────────┴──────────────┐
                 │                             │
                 ▼                             ▼
          ┌──────────────┐              ┌──────────────┐
          │ PostgreSQL   │              │    Redis     │
          │              │              │              │
          │ Durable data │              │ Fast state   │
          └──────────────┘              └──────┬───────┘
                                               │
                                               ▼
                                          BullMQ
                                               │
                                      ┌────────┼────────┐
                                      ▼        ▼        ▼
                                   Worker   Worker   Worker
```

But first we need to understand Redis independently.

---

# 3. What Redis Is

Redis is an in-memory data store.

The important concept is:


```
RAM
 │
 └── Redis
```

Compared with PostgreSQL:


```
PostgreSQL
    │
    ▼
Disk-oriented durable database
```

Redis is optimized for very fast operations on data structures held primarily in memory.

Redis supports data structures such as:


```
String
Hash
List
Set
Sorted Set
Stream
```

We will study these progressively.

---

# 4. Redis vs PostgreSQL

A simplified comparison:

| Requirement                 | PostgreSQL | Redis                           |
| --------------------------- | ---------- | ------------------------------- |
| Primary durable database    | Yes        | No                              |
| Relational queries          | Yes        | No                              |
| SQL                         | Yes        | No                              |
| Joins                       | Yes        | No                              |
| Transactions                | Yes        | Yes, but different semantics    |
| Very fast key/value access  | Good       | Excellent                       |
| Queue infrastructure        | Possible   | Excellent foundation            |
| Temporary state             | Possible   | Excellent                       |
| Distributed coordination    | Limited    | Common use case                 |
| Persistent business records | Yes        | Usually not the source of truth |

For our project:


```
PostgreSQL
    =
system of record
```

Redis:


```
Redis
    =
fast coordination/state infrastructure
```

This distinction is extremely important.

---

# 5. What We Will NOT Build Yet

This lecture deliberately does **not** introduce:


```
BullMQ
Queues
Workers
Producers
Retries
Backoff
Delayed jobs
Dead Letter Queues
Job priorities
Concurrency
```

Those belong to later lectures.

Our dependency progression is:


```
Module 1
   │
   ▼
Redis
   │
   ▼
Redis connection
   │
   ▼
Redis data structures
   │
   ▼
BullMQ
   │
   ▼
Queues
   │
   ▼
Workers
```

Do not skip this order.

---

# 6. Target Architecture

After this lecture:


```
                         Docker Compose
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
      ┌───────────────┐               ┌───────────────┐
      │      API      │               │   PostgreSQL  │
      │               │               │               │
      │ Node.js       │──────────────▶│ Port 5432     │
      │ Express       │               │               │
      │               │               └───────────────┘
      │ ioredis       │
      │      │        │
      └──────┼────────┘
             │
             │ redis:6379
             ▼
      ┌───────────────┐
      │     Redis     │
      │               │
      │ Port 6379     │
      └───────────────┘
```

The important Docker concept is:


```
API
 │
 │ redis:6379
 │
 ▼
Redis
```

Inside Docker Compose, the API should use:


```
REDIS_HOST=redis
```

not:


```
localhost
```

because inside the API container:


```
localhost
```

means:


```
the API container itself
```

---

# 7. Step 1 — Install the Redis Client

We will use:


```
ioredis
```

Run from the project root.

### Terminal


```
npm install ioredis
```

Verify:


```
npm list ioredis
```

Expected:


```
production-intelligence-platform
└── ioredis@...
```

Do not install BullMQ yet.

---

# 8. Step 2 — Update Environment Configuration

We need Redis configuration in our environment.

## File: `.env`

Add:


```
REDIS_HOST=localhost
REDIS_PORT=6379
```

The complete development file should now be:


```
NODE_ENV=development
PORT=3000

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

REDIS_HOST=localhost
REDIS_PORT=6379
```

---

## File: `.env.example`

Add:


```
REDIS_HOST=localhost
REDIS_PORT=6379
```

The complete relevant configuration becomes:


```
# Application
NODE_ENV=development
PORT=3000

# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
```

---

## File: `.env.test`

Add:


```
REDIS_HOST=localhost
REDIS_PORT=6379
```

The file should contain:


```
NODE_ENV=test
PORT=3001

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

REDIS_HOST=localhost
REDIS_PORT=6379
```

---

# 9. Step 3 — Update Configuration Types

## File: `src/config/config.types.ts`

### Replace the complete file with:


```
export type NodeEnvironment =
  | "development"
  | "test"
  | "production";

export interface ApplicationConfig {
  nodeEnv: NodeEnvironment;
  port: number;
}

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface RedisConfig {
  host: string;
  port: number;
}

export interface SecurityConfig {
  requestBodyLimit: string;
}

export interface AppConfig {
  app: ApplicationConfig;

  postgres: PostgresConfig;

  redis: RedisConfig;

  security: SecurityConfig;
}
```

We have now separated:


```
ApplicationConfig
PostgresConfig
RedisConfig
SecurityConfig
```

This keeps infrastructure configuration explicit.

---

# 10. Step 4 — Update Environment Loader

## File: `src/config/env.ts`

### Replace the complete file with:


```
import "dotenv/config";

import type {
  AppConfig,
  NodeEnvironment
} from "./config.types.js";

const parseRequiredString = (
  name: string
): string => {
  const value = process.env[name];

  if (
    value === undefined ||
    value.trim() === ""
  ) {
    throw new Error(
      `${name} environment variable is required`
    );
  }

  return value.trim();
};

const parsePositiveInteger = (
  name: string,
  value: string
): number => {
  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer`
    );
  }

  return parsed;
};

const parseEnvironment = (): NodeEnvironment => {
  const value =
    process.env.NODE_ENV ??
    "development";

  const allowed:
    NodeEnvironment[] = [
      "development",
      "test",
      "production"
    ];

  if (
    !allowed.includes(
      value as NodeEnvironment
    )
  ) {
    throw new Error(
      `Invalid NODE_ENV: ${value}`
    );
  }

  return value as NodeEnvironment;
};

const nodeEnv =
  parseEnvironment();

const port =
  parsePositiveInteger(
    "PORT",
    process.env.PORT ?? "3000"
  );

const postgresPort =
  parsePositiveInteger(
    "POSTGRES_PORT",
    process.env.POSTGRES_PORT ??
      "5432"
  );

const postgresHost =
  parseRequiredString(
    "POSTGRES_HOST"
  );

const postgresDatabase =
  parseRequiredString(
    "POSTGRES_DATABASE"
  );

const postgresUser =
  parseRequiredString(
    "POSTGRES_USER"
  );

const postgresPassword =
  parseRequiredString(
    "POSTGRES_PASSWORD"
  );

const redisHost =
  parseRequiredString(
    "REDIS_HOST"
  );

const redisPort =
  parsePositiveInteger(
    "REDIS_PORT",
    process.env.REDIS_PORT ??
      "6379"
  );

export const env: AppConfig = {
  app: {
    nodeEnv,
    port
  },

  postgres: {
    host:
      postgresHost,
    port:
      postgresPort,
    database:
      postgresDatabase,
    user:
      postgresUser,
    password:
      postgresPassword
  },

  redis: {
    host:
      redisHost,
    port:
      redisPort
  },

  security: {
    requestBodyLimit:
      "100kb"
  }
};
```

Notice the important design:


```
redis: {
  host: redisHost,
  port: redisPort
}
```

The Redis client will not contain hard-coded infrastructure addresses.

---

# 11. Step 5 — Add Redis to Docker Compose

## File: `docker-compose.yml`

We currently have:


```
postgres
api
```

Add Redis as a third service.

### Replace the complete file with:


```
services:

  postgres:
    image: postgres:17
    container_name: production-intelligence-postgres

    restart: unless-stopped

    environment:
      POSTGRES_DB: production_intelligence
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres

    ports:
      - "5432:5432"

    volumes:
      - postgres_data:/var/lib/postgresql/data

    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U postgres -d production_intelligence"
        ]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

    networks:
      - app-network


  redis:
    image: redis:8-alpine
    container_name: production-intelligence-redis

    restart: unless-stopped

    command:
      [
        "redis-server",
        "--appendonly",
        "yes"
      ]

    ports:
      - "6379:6379"

    volumes:
      - redis_data:/data

    healthcheck:
      test:
        [
          "CMD",
          "redis-cli",
          "ping"
        ]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

    networks:
      - app-network


  api:
    build:
      context: .
      dockerfile: Dockerfile

    container_name: production-intelligence-api

    restart: unless-stopped

    environment:
      NODE_ENV: production
      PORT: 3000

      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DATABASE: production_intelligence
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres

      REDIS_HOST: redis
      REDIS_PORT: 6379

    ports:
      - "3000:3000"

    depends_on:
      postgres:
        condition: service_healthy

      redis:
        condition: service_healthy

    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/health/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

    networks:
      - app-network


networks:

  app-network:
    driver: bridge


volumes:

  postgres_data:

  redis_data:
```

---

# 12. Why Are We Using A Redis Volume?

Redis is primarily an in-memory datastore.

But we are explicitly enabling:


```
appendonly yes
```

This enables Redis AOF persistence.

We also create:


```
redis_data:/data
```

So:


```
Redis container
      │
      ▼
/data
      │
      ▼
redis_data
```

This is useful for our development environment and teaches an important infrastructure concept.

However:

> Redis persistence does **not** mean Redis should automatically replace PostgreSQL as the source of truth.

Our business records remain in PostgreSQL.

---

# 13. Step 6 — Create Redis Client

Create the directory:

### PowerShell


```
New-Item -ItemType Directory -Force src\redis
```

Now create:

## File: `src/redis/client.ts`


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

    maxRetriesPerRequest: null
  });
```

---

# 14. Understand `lazyConnect`

We use:


```
lazyConnect: true
```

This means creating the client object does not immediately establish the network connection.

Instead:


```
new Redis(...)
       │
       ▼
client created
       │
       ▼
redis.connect()
       │
       ▼
network connection
```

This gives us explicit lifecycle control.

That is important for production systems.

---

# 15. Why `maxRetriesPerRequest: null`?

We are preparing this Redis client for the background-processing architecture that comes later.

BullMQ uses Redis heavily.

For long-running Redis-backed infrastructure, we don't want arbitrary command-level retry behavior to unexpectedly terminate requests.

For now, the important thing is simply:


```
Redis client configuration
        ↓
future BullMQ compatibility
```

We will revisit this configuration when BullMQ is introduced.

---

# 16. Step 7 — Create Redis Lifecycle

Create:

## File: `src/redis/lifecycle.ts`


```
import { redis } from "./client.js";

import { logger } from "../logging/logger.js";

export const connectRedis =
  async (): Promise<void> => {
    try {
      await redis.connect();

      await redis.ping();

      logger.info(
        "Redis connected",
        {
          host:
            redis.options.host,
          port:
            redis.options.port
        }
      );
    } catch (error) {
      logger.error(
        "Redis connection failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      throw error;
    }
  };

export const closeRedis =
  async (): Promise<void> => {
    if (
      redis.status ===
      "end"
    ) {
      return;
    }

    try {
      await redis.quit();

      logger.info(
        "Redis connection closed"
      );
    } catch (error) {
      logger.error(
        "Redis shutdown failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      throw error;
    }
  };
```

---

# 17. Understand Redis Lifecycle

We now explicitly control:


```
START
  │
  ▼
connectRedis()
  │
  ▼
Redis
  │
  ▼
Application ready
```

Shutdown:


```
SIGTERM
   │
   ▼
shutdown()
   │
   ▼
HTTP server closes
   │
   ▼
PostgreSQL closes
   │
   ▼
Redis closes
```

This is the correct direction for production infrastructure.

---

# 18. Step 8 — Connect Redis During Application Startup

## File: `src/server.ts`

### Replace the complete file with:


```
import { createServer } from "node:http";

import app from "./app.js";

import { env } from "./config/env.js";

import { logger } from "./logging/logger.js";

import {
  markApplicationReady
} from "./server/lifecycle.js";

import {
  shutdown
} from "./server/shutdown.js";

import {
  connectRedis
} from "./redis/lifecycle.js";

const server =
  createServer(app);

const start =
  async (): Promise<void> => {
    try {
      await connectRedis();

      server.listen(
        env.app.port,
        () => {
          markApplicationReady();

          logger.info(
            "Server started",
            {
              port:
                env.app.port,

              environment:
                env.app.nodeEnv
            }
          );
        }
      );
    } catch (error) {
      logger.error(
        "Application startup failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      process.exitCode = 1;
    }
  };

const handleShutdown =
  (signal: string) => {
    void shutdown(
      server,
      signal
    );
  };

process.on(
  "SIGINT",
  () => {
    handleShutdown("SIGINT");
  }
);

process.on(
  "SIGTERM",
  () => {
    handleShutdown("SIGTERM");
  }
);

void start();
```

---

# 19. Important Startup Change

Previously:


```
process starts
    │
    ▼
HTTP server listens
```

Now:


```
process starts
    │
    ▼
Connect Redis
    │
    ├── failure → application does not become ready
    │
    ▼
Start HTTP server
    │
    ▼
READY
```

This is deliberate.

We are saying:

> Redis is now a required infrastructure dependency of the application.

Later, we may decide that some Redis-dependent components should fail independently instead of taking down the entire API. That is a more advanced architecture decision.

For Lecture 1, we keep the lifecycle explicit and deterministic.

---

# 20. Step 9 — Close Redis During Shutdown

## File: `src/server/shutdown.ts`

### Replace the complete file with:


```
import type { Server } from "node:http";

import { pool } from "../database/pool.js";

import {
  closeRedis
} from "../redis/lifecycle.js";

import { logger } from "../logging/logger.js";

import {
  markApplicationShuttingDown,
  markApplicationStopped
} from "./lifecycle.js";

let isShuttingDown =
  false;

export const shutdown =
  async (
    server: Server,
    signal: string
  ): Promise<void> => {
    if (isShuttingDown) {
      logger.warn(
        "Shutdown already in progress",
        {
          signal
        }
      );

      return;
    }

    isShuttingDown =
      true;

    markApplicationShuttingDown();

    logger.info(
      "Graceful shutdown started",
      {
        signal
      }
    );

    try {
      await new Promise<void>(
        (
          resolve,
          reject
        ) => {
          server.close(
            (error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            }
          );
        }
      );

      logger.info(
        "HTTP server closed"
      );

      await pool.end();

      logger.info(
        "PostgreSQL connection pool closed"
      );

      await closeRedis();

      markApplicationStopped();

      logger.info(
        "Graceful shutdown completed"
      );

      process.exitCode = 0;
    } catch (error) {
      logger.error(
        "Graceful shutdown failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      process.exitCode = 1;
    }
  };
```

---

# 21. Final Shutdown Sequence

Our application now has:


```
SIGTERM
   │
   ▼
markApplicationShuttingDown()
   │
   ▼
Stop accepting HTTP
   │
   ▼
Close HTTP server
   │
   ▼
Close PostgreSQL pool
   │
   ▼
Close Redis
   │
   ▼
markApplicationStopped()
   │
   ▼
Exit
```

This sequence becomes increasingly important as Module 2 grows.

Eventually:


```
HTTP
Redis
BullMQ workers
PostgreSQL
WebSockets
```

will all need coordinated shutdown.

---

# 22. Step 10 — Verify TypeScript

Run:


```
npm run build
```

Expected:


```
tsc
```

with:


```
0 TypeScript errors
```

If you receive an error such as:


```
Property 'redis' does not exist on type 'AppConfig'
```

check:


```
src/config/config.types.ts
src/config/env.ts
```

first.

---

# 23. Step 11 — Start Redis

First validate Compose:


```
docker compose config
```

Then start:


```
docker compose up -d
```

Check:


```
docker compose ps
```

You should eventually see:


```
production-intelligence-postgres   healthy
production-intelligence-redis     healthy
production-intelligence-api       healthy
```

---

# 24. Step 12 — Verify Redis Container

Run:


```
docker compose logs redis --tail 50
```

You should see Redis startup messages.

Now inspect:


```
docker compose ps redis
```

The Redis service should report:


```
healthy
```

---

# 25. Step 13 — Verify Redis CLI

Run:


```
docker compose exec redis redis-cli ping
```

Expected:


```
PONG
```

This is the first direct proof that Redis is functioning.

---

# 26. Verify Redis Version

Run:


```
docker compose exec redis redis-cli INFO server
```

Find:


```
redis_version
```

This confirms the actual Redis server running inside Docker.

---

# 27. Step 14 — Verify Application → Redis

Check API logs:


```
docker compose logs api --tail 100
```

Look for:


```
Redis connected
```

followed by:


```
Server started
```

The important sequence is:


```
Redis connected
       ↓
Server started
```

not:


```
Server started
       ↓
Redis connected
```

because our application startup explicitly waits for Redis.

---

# 28. Verify API Health

Run:


```
Invoke-WebRequest `
  http://localhost:3000/health/live
```

Expected:


```
200
```

Then:


```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```

Expected:


```
200
```

---

# 29. Step 15 — Test Basic Redis Operations

Now we will interact directly with Redis.

Run:


```
docker compose exec redis `
  redis-cli SET lecture1 "redis-foundation"
```

Expected:


```
OK
```

Read it:


```
docker compose exec redis `
  redis-cli GET lecture1
```

Expected:


```
"redis-foundation"
```

Delete it:


```
docker compose exec redis `
  redis-cli DEL lecture1
```

Expected:


```
(integer) 1
```

Read again:


```
docker compose exec redis `
  redis-cli GET lecture1
```

Expected:


```
(nil)
```

---

# 30. Understand the SET/GET Model

Redis is fundamentally built around keys.


```
KEY
 │
 ▼
lecture1
 │
 ▼
VALUE
 │
 ▼
redis-foundation
```

Command:


```
SET lecture1 redis-foundation
```

means:


```
lecture1 → redis-foundation
```

Command:


```
GET lecture1
```

returns:


```
redis-foundation
```

---

# 31. Test Expiration

Run:


```
docker compose exec redis `
  redis-cli SET temporary-key "hello" EX 30
```

Then:


```
docker compose exec redis `
  redis-cli TTL temporary-key
```

You should get a value close to:


```
(integer) 30
```

After approximately 30 seconds:


```
docker compose exec redis `
  redis-cli GET temporary-key
```

Expected:


```
(nil)
```

This concept will become extremely important later for:


```
locks
sessions
temporary state
rate limiting
cache expiration
```

---

# 32. Test Hashes

Run:


```
docker compose exec redis `
  redis-cli HSET incident:demo service payment severity critical
```

Expected:


```
(integer) 2
```

Read:


```
docker compose exec redis `
  redis-cli HGETALL incident:demo
```

Expected conceptually:


```
service
payment
severity
critical
```

Delete:


```
docker compose exec redis `
  redis-cli DEL incident:demo
```

---

# 33. Why Redis Hashes Matter

A Redis hash allows multiple fields under one key:


```
incident:demo
    │
    ├── service  → payment
    ├── severity → critical
    └── status   → detected
```

Later we may use structures like this for:


```
job state
worker metadata
pipeline state
temporary counters
distributed coordination
```

---

# 34. Step 16 — Understand Redis Data Types

At a high level:

## String


```
SET key value
GET key
```

---

## Hash


```
HSET key field value
HGET key field
HGETALL key
```

---

## List


```
LPUSH key value
RPUSH key value
LPOP key
RPOP key
```

---

## Set


```
SADD key value
SMEMBERS key
SREM key value
```

---

## Sorted Set


```
ZADD key score value
ZRANGE key 0 -1
```

---

## Stream


```
XADD
XREAD
```

We will study these properly when each becomes relevant.

---

# 35. Redis Is More Than Key/Value Storage

A common beginner mistake is:

> "Redis is just a cache."

That is incomplete.

Redis can provide primitives for:


```
key/value state
counters
sets
queues
streams
expiration
atomic operations
coordination
locks
distributed state
```

BullMQ later builds a queue-processing abstraction using Redis.

---

# 36. Step 17 — Intentional Failure: Stop Redis

Now we deliberately break the infrastructure.

Run:


```
docker compose stop redis
```

Check:


```
docker compose ps
```

Redis should be stopped.

---

# 37. Observe API Behavior

Check API logs:


```
docker compose logs api --tail 100
```

Depending on exactly when Redis was stopped, you may see Redis connection/reconnection errors.

The important question is:

> What happens when a required infrastructure dependency disappears?

---

# 38. Verify Redis Is Actually Down

Run:


```
docker compose exec redis redis-cli ping
```

This command should fail because the Redis container is stopped.

Then:


```
docker compose ps
```

should show Redis is no longer running/healthy.

---

# 39. Important Failure Concept

We have now created this condition:


```
API
 │
 │
 X
 │
Redis unavailable
```

This is a real distributed-system problem.

The application and Redis are separate processes.

Therefore:


```
process A ≠ process B
```

and:


```
process A can be alive
while
process B is dead
```

This is one of the most important ideas we will build on throughout Module 2 and Module 3.

---

# 40. Step 18 — Recover Redis

Start Redis:


```
docker compose start redis
```

Check:


```
docker compose ps
```

Wait until:


```
production-intelligence-redis   healthy
```

Then:


```
docker compose exec redis redis-cli ping
```

Expected:


```
PONG
```

---

# 41. Verify API Recovery

Check:


```
docker compose logs api --tail 100
```

The Redis client may reconnect automatically depending on the state of the existing process/client.

The critical lesson is:


```
Redis failure
    ↓
Redis recovery
    ↓
connection recovery
```

We will make retry/reconnection behavior much more explicit and robust in later lectures.

---

# 42. Step 19 — Verify Graceful Redis Shutdown

Restart the API so we can observe its full startup/shutdown lifecycle.

Run:


```
docker compose restart api
```

Then:


```
docker compose logs api --tail 100
```

You should see the startup sequence containing:


```
Redis connected
```

and:


```
Server started
```

Now stop the API:


```
docker compose stop api
```

Inspect:


```
docker compose logs api --tail 100
```

Look for the shutdown sequence:


```
Graceful shutdown started
HTTP server closed
PostgreSQL connection pool closed
Redis connection closed
Graceful shutdown completed
```

The exact ordering in logs should follow the implementation.

---

# 43. Why `QUIT` Instead of Just Killing Redis Connection

Our lifecycle uses:


```
await redis.quit();
```

This asks Redis to close the connection cleanly.

We don't want every shutdown to behave like:


```
process killed
connection abandoned
```

Clean lifecycle management becomes critical when we eventually add:


```
BullMQ workers
```

because workers may have active jobs.

---

# 44. Step 20 — Run the Complete Test Suite

Start everything again:


```
docker compose up -d
```

Verify:


```
docker compose ps
```

Then:


```
npm run test:run
```

Finally:


```
npm run build
```

Both should pass.

---

# 45. Add Redis Configuration Test

We should extend configuration tests to verify Redis configuration is loaded correctly.

## File: `tests/config/env.test.ts`

Add a test appropriate to the existing test structure:


```
import { describe, expect, it } from "vitest";

import { env } from "../../src/config/env.js";

describe(
  "environment configuration",
  () => {
    it(
      "loads Redis configuration",
      () => {
        expect(
          env.redis.host
        ).toBeDefined();

        expect(
          env.redis.port
        ).toBeGreaterThan(0);
      }
    );
  }
);
```

If `tests/config/env.test.ts` already contains imports and a `describe` block, add only the `it(...)` test rather than creating duplicate imports or nested structures.

---

# 46. Run Configuration Tests

Run:


```
npm run test:run -- tests/config/env.test.ts
```

Expected:


```
PASS
```

Then run everything:


```
npm run test:run
```

---

# 47. Optional Direct Redis Verification Script

For learning purposes, create a temporary script.

Create:

## File: `src/redis/verify.ts`


```
import { redis } from "./client.js";

import {
  connectRedis,
  closeRedis
} from "./lifecycle.js";

const main =
  async (): Promise<void> => {
    try {
      await connectRedis();

      const pong =
        await redis.ping();

      console.log(
        "Redis PING:",
        pong
      );

      await redis.set(
        "lecture:1",
        "redis-foundation",
        "EX",
        60
      );

      const value =
        await redis.get(
          "lecture:1"
        );

      console.log(
        "Redis GET:",
        value
      );
    } finally {
      await closeRedis();
    }
  };

void main();
```

Run:


```
npx tsx src/redis/verify.ts
```

Expected:


```
Redis connected
Redis PING: PONG
Redis GET: redis-foundation
Redis connection closed
```

This is a very useful debugging technique.

---

# 48. Remove the Verification Script

This file is only for learning.

Remove:


```
Remove-Item src\redis\verify.ts
```

Why?

Because production code should not accumulate one-off infrastructure scripts unnecessarily.

We already have:


```
Redis client
Redis lifecycle
application startup
application shutdown
```

as the actual architecture.

---

# 49. Common Mistakes

## Mistake 1 — Using localhost inside Docker

Wrong:


```
REDIS_HOST=localhost
```

inside the API container.

Correct:


```
REDIS_HOST: redis
```

Why?

Docker Compose provides DNS:


```
redis
  ↓
Redis container
```

---

# 50. Mistake 2 — Installing Redis on Windows unnecessarily

For this project we are using Docker.

We do not need a separate native Redis installation.

Our architecture is:


```
Windows
   │
   ▼
Docker
   │
   ▼
Redis container
```

This keeps the development environment closer to containerized deployment.

---

# 51. Mistake 3 — Hardcoding Redis

Bad:


```
new Redis({
  host: "localhost",
  port: 6379
});
```

Better:


```
new Redis({
  host: env.redis.host,
  port: env.redis.port
});
```

Infrastructure should come from configuration.

---

# 52. Mistake 4 — Using PostgreSQL as a Queue

Do not start doing:


```
jobs table
poll jobs table
UPDATE jobs
SELECT jobs
```

just because PostgreSQL already exists.

That would defeat the purpose of learning the infrastructure architecture we are building.

Later:


```
Redis + BullMQ
```

will handle background-job coordination.

PostgreSQL will continue to store durable business data.

---

# 53. Mistake 5 — Treating Redis as the Source of Truth

Do not make:


```
Redis
```

the authoritative storage for an incident.

Our architecture remains:


```
Incident
   ↓
PostgreSQL
```

Redis will be used for infrastructure/state/coordination where appropriate.

---

# 54. Mistake 6 — Starting BullMQ Immediately

Don't install:


```
bullmq
```

yet.

We first need to understand:


```
Redis
   ↓
Redis connections
   ↓
Redis commands
   ↓
Redis lifecycle
   ↓
BullMQ
```

Otherwise BullMQ becomes a black box.

---

# 55. Production Improvements

This lecture intentionally implements a simple foundation.

A production Redis deployment can eventually require:


```
authentication
TLS
connection retry strategy
timeouts
monitoring
metrics
memory limits
eviction policy
persistence policy
replication
Sentinel
Cluster
backup strategy
failure recovery
```

We are not implementing all of these now.

The learning progression matters.

---

# 56. Redis Persistence vs PostgreSQL Persistence

We enabled:


```
AOF
```

for our Redis container.

Conceptually:


```
Redis memory
     │
     ▼
AOF
     │
     ▼
Redis volume
```

PostgreSQL:


```
PostgreSQL
     │
     ▼
database storage
     │
     ▼
postgres_data
```

These are different persistence systems with different guarantees and purposes.

Do not treat:


```
Redis persistence
```

as equivalent to:


```
PostgreSQL durability
```

for our application domain.

---

# 57. Redis Network Architecture

Our Docker network is:


```
app-network
```

Services:


```
postgres
redis
api
```

Therefore:


```
api
 │
 ├── postgres:5432
 │
 └── redis:6379
```

No container needs to know another container's IP address.

Docker's internal DNS resolves:


```
postgres
redis
```

to the corresponding service containers.

---

# 58. Redis Port Architecture

From Windows:


```
localhost:6379
```

maps to:


```
Redis container:6379
```

Inside Docker:


```
api
 │
 ▼
redis:6379
```

These are two different networking contexts.

This distinction is extremely important.

---

# 59. Final Module 2 Lecture 1 Architecture


```
                         HOST MACHINE
                              │
                              │
                       Docker Compose
                              │
          ┌───────────────────┼──────────────────┐
          │                   │                  │
          ▼                   ▼                  ▼
       API :3000         PostgreSQL :5432    Redis :6379
          │                   │                  │
          │                   │                  │
          │                   ▼                  ▼
          │             postgres_data        redis_data
          │
          │
          └───────────────┐
                          │
                          ▼
                       ioredis
                          │
                          ▼
                       Redis
```

---

# 60. Application Startup

Our startup sequence is now:


```
Node.js process
      │
      ▼
Load environment
      │
      ▼
Validate configuration
      │
      ▼
Create Redis client
      │
      ▼
connectRedis()
      │
      ▼
Redis PING
      │
      ▼
HTTP server starts
      │
      ▼
Application READY
```

---

# 61. Application Shutdown


```
SIGTERM
   │
   ▼
Shutdown begins
   │
   ▼
HTTP server closes
   │
   ▼
PostgreSQL pool closes
   │
   ▼
Redis connection closes
   │
   ▼
Application STOPPED
```

This is our first multi-infrastructure lifecycle.

---

# 62. Final Folder Structure

After Lecture 1:


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
│   │   └── incident.service.ts
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

# 63. Verification Checklist

Do not mark Lecture 1 complete until these pass.


```
DEPENDENCY
[ ] ioredis installed
[ ] package-lock.json updated

CONFIGURATION
[ ] REDIS_HOST exists
[ ] REDIS_PORT exists
[ ] RedisConfig exists
[ ] env.redis exists

DOCKER
[ ] Redis service exists
[ ] Redis healthcheck works
[ ] redis_data volume exists
[ ] API depends_on Redis

REDIS
[ ] Redis container starts
[ ] redis-cli ping returns PONG
[ ] Redis GET works
[ ] Redis SET works
[ ] Redis DEL works
[ ] Redis TTL works
[ ] Redis HSET/HGETALL works

APPLICATION
[ ] Redis client exists
[ ] Redis lifecycle exists
[ ] Application connects to Redis
[ ] API starts after Redis connection
[ ] Redis shutdown works

FAILURE
[ ] Redis can be intentionally stopped
[ ] Failure is observable
[ ] Redis can be restarted
[ ] Redis becomes healthy again

BUILD
[ ] npm run build passes
[ ] npm run test:run passes
[ ] docker compose config passes
[ ] docker compose up works
```

---

# 64. Assignment

Before moving to Lecture 2, manually perform these operations.

## Assignment 1 — String


```
docker compose exec redis `
  redis-cli SET student "production-engineer"
```

Then:


```
docker compose exec redis `
  redis-cli GET student
```

---

## Assignment 2 — Expiration


```
docker compose exec redis `
  redis-cli SET session:demo "active" EX 20
```

Then:


```
docker compose exec redis `
  redis-cli TTL session:demo
```

Observe the number decreasing.

---

## Assignment 3 — Hash


```
docker compose exec redis `
  redis-cli HSET worker:demo `
  status running `
  jobs 10 `
  name worker-1
```

Then:


```
docker compose exec redis `
  redis-cli HGETALL worker:demo
```

---

## Assignment 4 — Failure

Stop Redis:


```
docker compose stop redis
```

Observe API logs.

Then recover:


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

---

# 65. Questions You Must Be Able to Answer

Before moving forward, you should be able to explain:

### Question 1

Why do we use:


```
REDIS_HOST=redis
```

inside Docker instead of:


```
REDIS_HOST=localhost
```

---

### Question 2

What happens when:


```
redis-cli SET user:1 Omprakash
```

is executed?

---

### Question 3

What is the difference between:


```
SET
```

and:


```
HSET
```

---

### Question 4

What does:


```
EX 60
```

mean?

---

### Question 5

Why is PostgreSQL still the source of truth?

---

### Question 6

Why are we using:


```
lazyConnect: true
```

?

---

### Question 7

Why should Redis have its own lifecycle?

---

### Question 8

What happens if the API process is alive but Redis is dead?

---

### Question 9

Why do we not install BullMQ yet?

---

### Question 10

What is the difference between:


```
Redis
```

and:


```
BullMQ
```

?

The key conceptual answer is:


```
Redis
=
data store / infrastructure primitive

BullMQ
=
job queue abstraction built on Redis
```

---

# 66. Success Criteria

Lecture 1 is complete when you can demonstrate:


```
                    ┌─────────────────────┐
                    │      API            │
                    │                     │
                    │      ioredis        │
                    └──────────┬──────────┘
                               │
                               │ redis:6379
                               ▼
                    ┌─────────────────────┐
                    │       Redis         │
                    │                     │
                    │       PONG          │
                    └─────────────────────┘
```

and successfully execute:


```
SET
GET
DEL
TTL
HSET
HGETALL
```

while also proving:


```
Redis starts
      ↓
API connects
      ↓
API starts
      ↓
Redis fails
      ↓
failure observed
      ↓
Redis recovers
      ↓
system recovers
      ↓
API shuts down
      ↓
Redis connection closes
```

---

# 67. What We Have Actually Learned

The most important lesson of Lecture 1 is **not** the `SET` command.

It is this:


```
Redis is an independent distributed system component.
```

Our API and Redis are separate processes.

Therefore:


```
API can fail
Redis can fail
PostgreSQL can fail
```

independently.

That means production software must explicitly handle:


```
connection
failure
recovery
timeouts
lifecycle
state
```

This mindset is the foundation for the rest of Module 2.

---

# 68. Next Lecture

## Module 2 — Lecture 2

### **Redis Data Structures & Atomic Operations**

We will go deeper into:


```
Strings
Hashes
Lists
Sets
Sorted Sets
Counters
INCR
DECR
EXPIRE
TTL
Atomic operations
WATCH
MULTI
EXEC
```

Then we will connect these concepts to real backend problems:


```
counters
rate limiting
temporary state
worker state
coordination
```

Only after we understand these primitives will we introduce the queue abstraction.

---