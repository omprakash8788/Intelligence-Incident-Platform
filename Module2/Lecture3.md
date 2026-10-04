# Production Intelligence & Incident Platform

# Module 2 — Lecture 3: Redis Connection Management, Retry Strategy & Failure Recovery

> **Learning method**
>
> **Understand → Design → Implement → Test → Break → Observe → Fix → Recover → Verify**
>
> In Lecture 1 we connected the application to Redis.
>
> In Lecture 2 we learned Redis data structures and atomic operations.
>
> Now we make the Redis connection layer production-oriented.
>
> **BullMQ is still NOT introduced in this lecture.**

---

# Table of Contents

1. [Lecture Objective](#1-lecture-objective)
2. [Why Redis Connection Management Matters](#2-why-redis-connection-management-matters)
3. [Current Architecture](#3-current-architecture)
4. [Redis Connection States](#4-redis-connection-states)
5. [What We Need to Handle](#5-what-we-need-to-handle)
6. [Important ioredis Events](#6-important-ioredis-events)
7. [Step 1 — Inspect Current Redis Client](#7-step-1--inspect-current-redis-client)
8. [Step 2 — Design the Connection Configuration](#8-step-2--design-the-connection-configuration)
9. [Step 3 — Update Configuration Types](#9-step-3--update-configuration-types)
10. [Step 4 — Update Environment Configuration](#10-step-4--update-environment-configuration)
11. [Step 5 — Update Redis Client](#11-step-5--update-redis-client)
12. [Step 6 — Build Redis Lifecycle Manager](#12-step-6--build-redis-lifecycle-manager)
13. [Step 7 — Handle Redis Events](#13-step-7--handle-redis-events)
14. [Step 8 — Prevent Duplicate Event Registration](#14-step-8--prevent-duplicate-event-registration)
15. [Step 9 — Update Application Startup](#15-step-9--update-application-startup)
16. [Step 10 — Update Graceful Shutdown](#16-step-10--update-graceful-shutdown)
17. [Step 11 — Add Redis Health Check](#17-step-11--add-redis-health-check)
18. [Step 12 — Update Readiness](#18-step-12--update-readiness)
19. [Step 13 — Build](#19-step-13--build)
20. [Step 14 — Start Redis and API](#20-step-14--start-redis-and-api)
21. [Step 15 — Verify Connection](#21-step-15--verify-connection)
22. [Step 16 — Verify Redis Events](#22-step-16--verify-redis-events)
23. [Step 17 — Runtime Failure Test](#23-step-17--runtime-failure-test)
24. [Step 18 — Redis Recovery Test](#24-step-18--redis-recovery-test)
25. [Step 19 — Startup Failure Test](#25-step-19--startup-failure-test)
26. [Step 20 — Startup Recovery](#26-step-20--startup-recovery)
27. [Step 21 — Verify Readiness During Failure](#27-step-21--verify-readiness-during-failure)
28. [Step 22 — Test Redis Commands After Recovery](#28-step-22--test-redis-commands-after-recovery)
29. [Step 23 — Run Automated Tests](#29-step-23--run-automated-tests)
30. [Step 24 — Intentional Configuration Failure](#30-step-24--intentional-configuration-failure)
31. [Step 25 — Final Recovery](#31-step-25--final-recovery)
32. [Why Retry Strategy Is Dangerous](#32-why-retry-strategy-is-dangerous)
33. [Connection Retry Backoff](#33-connection-retry-backoff)
34. [What Happens During a Network Failure](#34-what-happens-during-a-network-failure)
35. [Final Redis Lifecycle](#35-final-redis-lifecycle)
36. [Final Architecture](#36-final-architecture)
37. [Final Folder Structure](#37-final-folder-structure)
38. [Verification Checklist](#38-verification-checklist)
39. [Questions You Must Answer](#39-questions-you-must-answer)
40. [Success Criteria](#40-success-criteria)
41. [Next Lecture](#41-next-lecture)

---

# 1. Lecture Objective

Our Redis connection currently works, but a production system needs to answer more questions.

What happens when:

```text
Redis is down?
```
What happens when:

```
Redis suddenly disconnects?
```

What happens when:

```
Redis comes back?
```

What happens when:

```
the network temporarily disappears?
```

What happens when:

```
the application starts before Redis?
```

What happens when:

```
Redis refuses the connection?
```

These are not theoretical questions.

Distributed systems fail.

Therefore, this lecture establishes:

```
Redis
  │
  ├── connection lifecycle
  ├── error handling
  ├── retry behavior
  ├── reconnect behavior
  ├── readiness
  ├── logging
  └── graceful shutdown
```

---

# 2. Why Redis Connection Management Matters

A naive application does:

```
create Redis client
      ↓
connect
      ↓
done
```

A production application must handle:

```
                 Redis
                   │
        ┌──────────┼──────────┐
        │          │          │
        ▼          ▼          ▼
    connected   failed    reconnecting
        │          │          │
        └──────────┴──────────┘
                   │
                   ▼
                ready
```

The application must understand the difference between:

```
Redis is connected
```

and:

```
Redis connection object exists
```

Those are not the same thing.

---

# 3. Current Architecture

Our current application is:

```
                         API
                          │
                          ▼
                     ioredis
                          │
                          ▼
                        Redis
```

PostgreSQL is still:

```
                         API
                          │
                          ▼
                     PostgreSQL
```

We now have two infrastructure dependencies:

```
                 API
                /   \
               /     \
              ▼       ▼
        PostgreSQL    Redis
```

Therefore the application lifecycle needs to understand both.

---

# 4. Redis Connection States

Conceptually, Redis can move through states such as:

```
                         ┌──────────────┐
                         │  DISCONNECTED│
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │  CONNECTING  │
                         └──────┬───────┘
                                │
                         success│
                                ▼
                         ┌──────────────┐
                         │   CONNECTED  │
                         └──────┬───────┘
                                │
                                │ failure
                                ▼
                         ┌──────────────┐
                         │ RECONNECTING │
                         └──────┬───────┘
                                │
                         success│
                                ▼
                         ┌──────────────┐
                         │   CONNECTED  │
                         └──────────────┘
```

Shutdown is different:

```
CONNECTED
    │
    ▼
QUIT
    │
    ▼
CLOSED
```

We do not want the application to interpret an intentional shutdown as a network failure.

---

# 5. What We Need to Handle

We need to distinguish:

## Startup failure

```
API starts
   │
   ▼
Redis unavailable
   │
   ▼
connection fails
```

---

## Runtime failure

```
API running
   │
   ▼
Redis connection works
   │
   ▼
Redis disappears
   │
   ▼
reconnection
```

---

## Recovery

```
Redis unavailable
       │
       ▼
Redis starts again
       │
       ▼
client reconnects
       │
       ▼
Redis ready
```

---

## Shutdown

```
SIGTERM
   │
   ▼
HTTP closes
   │
   ▼
PostgreSQL closes
   │
   ▼
Redis closes
```

These are four different situations.

---

# 6. Important ioredis Events

ioredis exposes events that help us observe connection state.

Important events include:

```
connect
ready
error
close
reconnecting
end
```

Conceptually:

```
connect
   ↓
ready
```

means:

```
TCP connection established
   ↓
Redis client ready for commands
```

If a problem occurs:

```
error
   ↓
close
   ↓
reconnecting
```

Potentially:

```
reconnecting
   ↓
connect
   ↓
ready
```

---

# 7. Step 1 — Inspect Current Redis Client

## File: `src/redis/client.ts`

Our current implementation is approximately:

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

This works, but the retry behavior is not explicit enough for what we are trying to learn.

We will now make the behavior explicit.

---

# 8. Step 2 — Design the Connection Configuration

We will add:

```
connectTimeout
retry strategy
```

The configuration will conceptually become:

```
Redis configuration
│
├── host
├── port
├── connectTimeout
└── retry behavior
```

We will keep retry behavior inside the Redis infrastructure layer rather than exposing every Redis library option through application configuration.

This is an important architectural decision.

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
  connectTimeoutMs: number;
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

---

# 10. Step 4 — Update Environment Configuration

## File: `.env`

Add:

```
REDIS_CONNECT_TIMEOUT_MS=5000
```

The Redis section becomes:

```
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_CONNECT_TIMEOUT_MS=5000
```

---

## File: `.env.example`

Add:

```
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_CONNECT_TIMEOUT_MS=5000
```

---

## File: `.env.test`

Add:

```
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_CONNECT_TIMEOUT_MS=5000
```

---

# 11. Update Environment Loader

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

const redisConnectTimeoutMs =
  parsePositiveInteger(
    "REDIS_CONNECT_TIMEOUT_MS",
    process.env.REDIS_CONNECT_TIMEOUT_MS ??
      "5000"
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
      redisPort,
    connectTimeoutMs:
      redisConnectTimeoutMs
  },

  security: {
    requestBodyLimit:
      "100kb"
  }
};
```

---

# 12. Step 5 — Update Redis Client

## File: `src/redis/client.ts`

### Replace the complete file with:

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

---

# 13. Understand `retryStrategy`

We have:

```
retryStrategy: (times) => {
  const delay = Math.min(
    times * 500,
    5000
  );

  return delay;
}
```

This means approximately:

```
attempt 1 → 500ms
attempt 2 → 1000ms
attempt 3 → 1500ms
attempt 4 → 2000ms
...
attempt 10 → 5000ms
attempt 11 → 5000ms
```

The maximum delay is:

```
5 seconds
```

---

# 14. Why Not Retry Every Millisecond?

Imagine Redis is down for 10 minutes.

If the client retries aggressively:

```
retry
retry
retry
retry
retry
retry
...
```

we create unnecessary pressure.

A retry delay gives the infrastructure time to recover.

This concept is:

```
backoff
```

We will study exponential backoff more deeply when BullMQ jobs are introduced.

---

# 15. Why Cap the Delay?

Without a maximum:

```
delay
delay
delay
delay
...
```

could become excessively long.

With:

```
Math.min(
  times * 500,
  5000
)
```

we get:

```
500ms
1000ms
1500ms
...
5000ms
5000ms
5000ms
```

This is a simple linear backoff with a cap.

It is intentionally simple for this lecture.

---

# 16. Step 6 — Build Redis Lifecycle Manager

## File: `src/redis/lifecycle.ts`

### Replace the complete file with:

```
import {
  redis
} from "./client.js";

import {
  logger
} from "../logging/logger.js";

let eventsRegistered =
  false;

export const registerRedisEvents =
  (): void => {
    if (eventsRegistered) {
      return;
    }

    eventsRegistered =
      true;

    redis.on(
      "connect",
      () => {
        logger.info(
          "Redis socket connected"
        );
      }
    );

    redis.on(
      "ready",
      () => {
        logger.info(
          "Redis client ready"
        );
      }
    );

    redis.on(
      "error",
      (error: Error) => {
        logger.error(
          "Redis connection error",
          {
            error:
              error.message
          }
        );
      }
    );

    redis.on(
      "close",
      () => {
        logger.warn(
          "Redis connection closed"
        );
      }
    );

    redis.on(
      "reconnecting",
      (delay: number) => {
        logger.warn(
          "Redis reconnecting",
          {
            delayMs: delay
          }
        );
      }
    );

    redis.on(
      "end",
      () => {
        logger.info(
          "Redis connection ended"
        );
      }
    );
  };

export const connectRedis =
  async (): Promise<void> => {
    registerRedisEvents();

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
        "Redis initial connection failed",
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
        "Redis connection closed cleanly"
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

export const isRedisReady =
  (): boolean => {
    return (
      redis.status ===
      "ready"
    );
  };
```

---

# 17. Step 7 — Handle Redis Events

We now observe:

```
connect
ready
error
close
reconnecting
end
```

The distinction is important.

## `connect`

The underlying socket has connected.

```
TCP connection
     ↓
connect
```

---

## `ready`

The Redis client is ready to accept commands.

```
Redis handshake/setup
       ↓
ready
```

For application readiness, this is the more useful state.

---

## `error`

A Redis connection error occurred.

```
Redis
  X
error
```

---

## `close`

The connection closed.

---

## `reconnecting`

ioredis is attempting to reconnect.

---

## `end`

The connection has ended and will not continue reconnecting.

This commonly matters during intentional shutdown.

---

# 18. Step 8 — Prevent Duplicate Event Registration

Notice:

```
let eventsRegistered =
  false;
```

and:

```
if (eventsRegistered) {
  return;
}
```

Why?

Because if:

```
connectRedis()
```

were called multiple times and we repeatedly executed:

```
redis.on(...)
```

we could register the same listeners multiple times.

Then one event could produce:

```
Redis reconnecting
Redis reconnecting
Redis reconnecting
Redis reconnecting
```

from one actual event.

We prevent that.

---

# 19. Step 9 — Update Application Startup

## File: `src/server.ts`

Our previous startup already calls:

```
await connectRedis();
```

Keep that behavior.

The complete file should be:

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

# 20. Important Startup Property

The startup sequence is now:

```
process starts
      │
      ▼
load configuration
      │
      ▼
create Redis client
      │
      ▼
connectRedis()
      │
      ▼
Redis ready
      │
      ▼
server.listen()
      │
      ▼
application ready
```

Therefore:

```
Redis unavailable
      │
      ▼
application cannot become READY
```

This is intentional.

---

# 21. Step 10 — Update Graceful Shutdown

## File: `src/server/shutdown.ts`

Keep the Redis shutdown logic from Lecture 1.

The complete file should be:

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

# 22. Step 11 — Add Redis Health Check

We already have:

```
/health/live
/health/ready
```

Now readiness must understand Redis.

## File: `src/database/health.ts`

If this file currently contains PostgreSQL health logic, keep it unchanged.

Create a separate Redis health module.

## File: `src/redis/health.ts`

```
import {
  redis
} from "./client.js";

export const checkRedisHealth =
  async (): Promise<boolean> => {
    try {
      const result =
        await redis.ping();

      return result === "PONG";
    } catch {
      return false;
    }
  };
```

This gives us:

```
Redis health
   │
   ▼
PING
   │
   ▼
PONG
```

---

# 23. Why `isRedisReady()` Alone Is Not Enough

We created:

```
isRedisReady()
```

which checks:

```
redis.status === "ready"
```

That is useful.

But readiness can also perform an actual command:

```
PING
```

Why?

Because:

```
client state
```

and:

```
successful communication
```

are related but not identical concepts.

For dependency health, an actual operation gives stronger evidence.

---

# 24. Step 12 — Update Readiness

## File: `src/controllers/health.controller.ts`

Your existing controller already checks application lifecycle and PostgreSQL.

Update the readiness logic so Redis is also checked.

The relevant complete implementation should follow this pattern:

```
import type {
  Request,
  Response
} from "express";

import {
  getApplicationState
} from "../server/lifecycle.js";

import {
  checkDatabaseHealth
} from "../database/health.js";

import {
  checkRedisHealth
} from "../redis/health.js";

export const livenessController =
  (
    _req: Request,
    res: Response
  ): void => {
    res.status(200).json({
      success: true,
      data: {
        status: "alive"
      }
    });
  };

export const readinessController =
  async (
    _req: Request,
    res: Response
  ): Promise<void> => {
    const state =
      getApplicationState();

    if (
      state !== "ready"
    ) {
      res.status(503).json({
        success: false,
        error: {
          code:
            "SERVICE_NOT_READY",
          message:
            "Service is not ready"
        }
      });

      return;
    }

    const [
      databaseHealthy,
      redisHealthy
    ] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth()
    ]);

    if (
      !databaseHealthy ||
      !redisHealthy
    ) {
      res.status(503).json({
        success: false,
        error: {
          code:
            "DEPENDENCY_NOT_READY",
          message:
            "One or more dependencies are unavailable"
        }
      });

      return;
    }

    res.status(200).json({
      success: true,
      data: {
        status: "ready"
      }
    });
  };

export const healthController =
  async (
    _req: Request,
    res: Response
  ): Promise<void> => {
    const state =
      getApplicationState();

    const [
      databaseHealthy,
      redisHealthy
    ] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth()
    ]);

    const healthy =
      state === "ready" &&
      databaseHealthy &&
      redisHealthy;

    res
      .status(
        healthy
          ? 200
          : 503
      )
      .json({
        success: healthy,
        data: {
          status: healthy
            ? "healthy"
            : "unhealthy"
        }
      });
  };
```

> **Important:** If your current `health.controller.ts` has additional response fields or helper functions from earlier lectures, preserve them. The essential change is that Redis participates in dependency readiness.

---

# 25. Why Use `Promise.all()`?

We have two independent health checks:

```
PostgreSQL
Redis
```

There is no reason to wait:

```
PostgreSQL
   ↓
finished
   ↓
Redis
   ↓
finished
```

Instead:

```
PostgreSQL ─────┐
                ├── Promise.all()
Redis ──────────┘
```

Both checks can run concurrently.

This reduces readiness latency.

---

# 26. Health Semantics After Lecture 3

Our model is now:

```
                    Application
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
         PostgreSQL              Redis
              │                     │
              ▼                     ▼
           healthy?              healthy?
              │                     │
              └──────────┬──────────┘
                         │
                         ▼
                    /health/ready
```

Therefore:

```
PostgreSQL down
     ↓
503
```

Redis down:

```
Redis down
     ↓
503
```

Both healthy:

```
200
```

---

# 27. Step 13 — Build

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
0 errors
```

If you get a type error in the health controller, fix it before continuing.

---

# 28. Step 14 — Start Redis and API

Start everything:

```
docker compose up -d
```

Check:

```
docker compose ps
```

Expected:

```
production-intelligence-postgres   healthy
production-intelligence-redis      healthy
production-intelligence-api       healthy
```

---

# 29. Step 15 — Verify Connection

Run:

```
docker compose logs api --tail 50
```

The startup sequence should now contain messages conceptually like:

```
Redis socket connected
Redis client ready
Redis connected
Server started
```

The exact JSON representation depends on your logger.

The important ordering is:

```
Redis connected
      ↓
Server started
```

---

# 30. Verify Redis Directly

Run:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

---

# 31. Verify API Readiness

Run:

```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```

Expected:

```
200
```

---

# 32. Step 16 — Verify Redis Events

Restart the API:

```
docker compose restart api
```

Then:

```
docker compose logs api --tail 30
```

You should see the connection lifecycle.

Conceptually:

```
Redis socket connected
Redis client ready
Redis connected
Server started
```

This is much better than simply seeing:

```
Server started
```

because we can now observe the infrastructure lifecycle.

---

# 33. Step 17 — Runtime Failure Test

Now the important test.

Stop Redis:

```
docker compose stop redis
```

Do not restart the API yet.

Check:

```
docker compose ps
```

Redis should be stopped.

---

# 34. Observe API Logs

Run:

```
docker compose logs api --tail 100
```

You should eventually see messages such as:

```
Redis connection closed
Redis reconnecting
```

and possibly:

```
Redis connection error
```

The exact sequence depends on timing and Docker networking.

Do not worry if event ordering varies slightly.

The important thing is that Redis failure is observable.

---

# 35. Verify Readiness

Run:

```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```

Expected:

```
503
```

This is critical.

The API process is alive:

```
/health/live → 200
```

but Redis is unavailable:

```
/health/ready → 503
```

---

# 36. Verify Liveness During Redis Failure

Run:

```
Invoke-WebRequest `
  http://localhost:3000/health/live
```

Expected:

```
200
```

This demonstrates:

```
API process alive
       ≠
API dependencies healthy
```

That distinction is fundamental to production systems.

---

# 37. Step 18 — Redis Recovery Test

Start Redis:

```
docker compose start redis
```

Wait:

```
docker compose ps redis
```

Until:

```
healthy
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

# 38. Observe Reconnection

Run:

```
docker compose logs api --tail 100
```

You should see the Redis lifecycle move toward:

```
Redis reconnecting
      ↓
Redis socket connected
      ↓
Redis client ready
```

Again, the exact ordering of individual events can vary.

The key result is:

```
Redis unavailable
      ↓
Redis recovered
      ↓
Redis client reconnects
```

---

# 39. Verify Readiness Recovery

Run:

```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```

Expected:

```
200
```

We have now demonstrated:

```
              Redis
                │
          ┌─────┴─────┐
          │           │
       failure      recovery
          │           │
          ▼           ▼
       ready 503   ready 200
```

---

# 40. Step 19 — Startup Failure Test

Now we test a different scenario.

Stop Redis:

```
docker compose stop redis
```

Then recreate the API:

```
docker compose restart api
```

Because Redis is unavailable, the API startup should not successfully become ready.

Inspect:

```
docker compose logs api --tail 100
```

You should see Redis connection failure/retry behavior.

---

# 41. Important Observation

There is an important distinction between:

```
runtime Redis failure
```

and:

```
startup Redis failure
```

Runtime:

```
API
 │
 ▼
Redis
 │
 X
failure
 │
 ▼
reconnect
```

Startup:

```
API starting
    │
    ▼
Redis unavailable
    │
    ▼
connection attempt
    │
    ▼
retry
```

Our retry strategy prevents an immediate, uncontrolled connection storm.

---

# 42. Step 20 — Startup Recovery

Start Redis:

```
docker compose start redis
```

Wait:

```
docker compose ps redis
```

Then check:

```
docker compose ps
```

If your API container remained alive and the Redis client was retrying, it should eventually become healthy.

If the API container exited because startup failed in your Docker/runtime timing, recreate it:

```
docker compose up -d --force-recreate api
```

Then:

```
docker compose ps
```

Expected:

```
postgres   healthy
redis      healthy
api        healthy
```

---

# 43. Step 21 — Verify Readiness During Failure

We now repeat the failure test carefully.

Stop Redis:

```
docker compose stop redis
```

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
503
```

This is our intended behavior.

---

# 44. Step 22 — Test Redis Commands After Recovery

Start Redis:

```
docker compose start redis
```

Wait until healthy:

```
docker compose ps redis
```

Then run:

```
docker compose exec redis redis-cli `
  SET lecture3:recovery "working"
```

Expected:

```
OK
```

Read it:

```
docker compose exec redis redis-cli `
  GET lecture3:recovery
```

Expected:

```
"working"
```

---

# 45. Test Through the Application

Our Redis service should still work after recovery.

Run the Redis tests:

```
npm run test:run -- tests/redis/redis.service.test.ts
```

Expected:

```
PASS
```

---

# 46. Step 23 — Run Automated Tests

Run configuration tests:

```
npm run test:run -- tests/config/env.test.ts
```

Then Redis tests:

```
npm run test:run -- tests/redis/redis.service.test.ts
```

Then the complete suite:

```
npm run test:run
```

Finally:

```
npm run build
```

All must pass.

---

# 47. Add Redis Health Tests

Create:

## File: `tests/redis/health.test.ts`

```
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import {
  connectRedis,
  closeRedis
} from "../../src/redis/lifecycle.js";

import {
  checkRedisHealth
} from "../../src/redis/health.js";

describe(
  "Redis health",
  () => {
    beforeAll(
      async () => {
        await connectRedis();
      }
    );

    afterAll(
      async () => {
        await closeRedis();
      }
    );

    it(
      "returns true when Redis responds to PING",
      async () => {
        const healthy =
          await checkRedisHealth();

        expect(
          healthy
        ).toBe(true);
      }
    );
  }
);
```

---

# 48. Run Redis Health Test

Make sure Redis is running:

```
docker compose start redis
```

Then:

```
npm run test:run -- tests/redis/health.test.ts
```

Expected:

```
PASS
```

---

# 49. Update Environment Test

## File: `tests/config/env.test.ts`

Add:

```
it(
  "loads Redis connection timeout",
  () => {
    expect(
      env.redis.connectTimeoutMs
    ).toBeGreaterThan(0);
  }
);
```

Make sure the file imports:

```
import { env } from "../../src/config/env.js";
```

---

# 50. Step 24 — Intentional Configuration Failure

Now we deliberately create a bad Redis configuration.

Do **not** modify your real `.env`.

Instead, temporarily change the Docker Compose API environment.

## File: `docker-compose.yml`

Temporarily change:

```
REDIS_PORT: 6379
```

to:

```
REDIS_PORT: 6399
```

This means:

```
API
 │
 │ 6399
 ▼
Redis
 │
 │ actually listening
 ▼
6379
```

The connection should fail.

---

# 51. Recreate API

Run:

```
docker compose up -d --force-recreate api
```

Then:

```
docker compose logs api --tail 100
```

You should see Redis connection errors/retry activity.

The API should not successfully establish Redis connectivity.

---

# 52. Fix the Configuration

Restore:

## File: `docker-compose.yml`

```
REDIS_PORT: 6379
```

Then:

```
docker compose up -d --force-recreate api
```

Check:

```
docker compose ps
```

Expected:

```
api      healthy
redis    healthy
postgres healthy
```

---

# 53. Step 25 — Final Recovery

Run:

```
docker compose exec redis redis-cli ping
```

Expected:

```
PONG
```

Then:

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

Finally:

```
docker compose logs api --tail 50
```

You should see a successful Redis startup sequence.

---

# 54. Why Retry Strategy Is Dangerous

Retrying is useful.

But retrying blindly can create serious problems.

Imagine:

```
100 API instances
```

and Redis goes down.

If every instance retries aggressively:

```
100 instances
 ×
thousands of retries
 =
huge connection pressure
```

When Redis comes back, all clients may reconnect simultaneously.

This is called a:

```
thundering herd
```

problem.

Backoff reduces this pressure.

---

# 55. Retry Strategy Is Not Enough

A retry strategy solves:

```
when should I try again?
```

It does not solve:

```
what should my application do while Redis is unavailable?
```

Those are separate questions.

For example:

```
Redis unavailable
       │
       ├── queue operation
       ├── cache operation
       ├── lock operation
       └── health check
```

Different operations may require different behavior.

Later, when BullMQ is introduced, this becomes especially important.

---

# 56. Connection Retry vs Job Retry

These are completely different concepts.

## Connection retry

```
Redis connection
      │
      X
      │
      ▼
try again
```

---

## Job retry

```
Job
 │
 X
failure
 │
 ▼
wait
 │
 ▼
retry job
```

Do not confuse them.

Connection retry belongs to:

```
infrastructure
```

Job retry belongs to:

```
background processing
```

---

# 57. Connection Retry vs Request Retry

Another important distinction.

A client might retry:

```
HTTP request
```

while the Redis client retries:

```
Redis connection
```

And later BullMQ retries:

```
job
```

We can therefore have multiple layers:

```
HTTP retry
   │
   ▼
API
   │
   ▼
Redis connection retry
   │
   ▼
BullMQ job retry
```

If designed badly, these layers can multiply retries.

This is why retry architecture needs deliberate design.

---

# 58. Connection Retry Backoff

Our current simple strategy is:

```
attempt       delay

1             500ms
2             1000ms
3             1500ms
4             2000ms
5             2500ms
6             3000ms
7             3500ms
8             4000ms
9             4500ms
10            5000ms
11            5000ms
...
```

This is:

```
linear backoff + cap
```

We are deliberately not implementing random jitter yet.

Jitter becomes important when many distributed clients reconnect simultaneously.

---

# 59. Why Jitter Matters

Imagine:

```
API-1 retries at 5 seconds
API-2 retries at 5 seconds
API-3 retries at 5 seconds
...
API-100 retries at 5 seconds
```

They may synchronize.

With jitter:

```
API-1 → 4.6s
API-2 → 5.2s
API-3 → 4.8s
API-4 → 5.4s
```

The load becomes more distributed.

We will revisit jitter in later distributed-system lectures.

---

# 60. What Happens During a Network Failure

Suppose:

```
API
 │
 ▼
Redis
```

Then the network fails:

```
API
 │
 X
 │
Redis
```

ioredis can detect the connection loss.

The lifecycle becomes:

```
ready
  │
  X network failure
  │
  ▼
close/error
  │
  ▼
reconnecting
  │
  ▼
connect
  │
  ▼
ready
```

This is the behavior we wanted to make observable.

---

# 61. Readiness During Reconnection

While Redis is reconnecting:

```
redis.status
```

will not necessarily be:

```
ready
```

Our health check performs:

```
PING
```

Therefore readiness should fail:

```
Redis reconnecting
      │
      ▼
PING unavailable
      │
      ▼
503
```

After recovery:

```
Redis ready
      │
      ▼
PING → PONG
      │
      ▼
200
```

---

# 62. Why Liveness Remains 200

Liveness asks:

> Is the process alive?

Readiness asks:

> Can this service safely receive traffic?

Therefore:

```
Redis down

/health/live
    ↓
200

/health/ready
    ↓
503
```

This is intentional.

---

# 63. Final Redis Lifecycle

Our Redis lifecycle is now:

```
                         Application
                              │
                              ▼
                     create Redis client
                              │
                              ▼
                       connectRedis()
                              │
                              ▼
                         CONNECTING
                              │
                     ┌────────┴────────┐
                     │                 │
                  success            failure
                     │                 │
                     ▼                 ▼
                  CONNECTED       retry/backoff
                     │                 │
                     ▼                 │
                   READY ◀─────────────┘
                     │
                     │ runtime failure
                     ▼
                 RECONNECTING
                     │
                     ▼
                   READY
                     │
                     │ shutdown
                     ▼
                    QUIT
                     │
                     ▼
                   CLOSED
```

---

# 64. Final Application Lifecycle

We now have:

```
START
 │
 ▼
Load configuration
 │
 ▼
Validate configuration
 │
 ▼
Create Redis client
 │
 ▼
Connect Redis
 │
 ▼
Redis ready
 │
 ▼
Start HTTP server
 │
 ▼
Application ready
```

Shutdown:

```
SIGTERM
 │
 ▼
Stop HTTP
 │
 ▼
Close PostgreSQL
 │
 ▼
Close Redis
 │
 ▼
STOPPED
```

---

# 65. Final Architecture

```
                         Docker Compose
                              │
              ┌───────────────┼────────────────┐
              │               │                │
              ▼               ▼                ▼
          ┌───────┐      ┌──────────┐     ┌─────────┐
          │  API  │      │PostgreSQL│     │  Redis  │
          └───┬───┘      └──────────┘     └────┬────┘
              │                                  │
              │                                  │
              ▼                                  │
         ┌──────────┐                            │
         │ ioredis  │────────────────────────────┘
         └────┬─────┘
              │
              ▼
       Redis Lifecycle
              │
      ┌───────┼────────┐
      │       │        │
      ▼       ▼        ▼
   connect   retry    health
      │       │        │
      └───────┼────────┘
              │
              ▼
          Redis 7/8+
```

---

# 66. Final Folder Structure

After Lecture 3:

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
│   │   ├── health.ts
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
│   │   ├── health.test.ts
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

# 67. Verification Checklist

## Configuration

```
[ ] REDIS_HOST exists
[ ] REDIS_PORT exists
[ ] REDIS_CONNECT_TIMEOUT_MS exists
[ ] RedisConfig contains connectTimeoutMs
[ ] env.redis.connectTimeoutMs is validated
```

## Redis Client

```
[ ] lazyConnect enabled
[ ] connectTimeout configured
[ ] maxRetriesPerRequest configured
[ ] retryStrategy configured
```

## Lifecycle

```
[ ] connect event logged
[ ] ready event logged
[ ] error event logged
[ ] close event logged
[ ] reconnecting event logged
[ ] end event logged
[ ] duplicate listeners prevented
```

## Health

```
[ ] Redis health check exists
[ ] readiness checks PostgreSQL
[ ] readiness checks Redis
[ ] Redis failure returns 503
[ ] Redis recovery returns 200
[ ] liveness remains independent
```

## Failure

```
[ ] Redis runtime failure tested
[ ] Redis reconnect tested
[ ] Redis startup failure tested
[ ] Redis configuration failure tested
[ ] Redis recovery tested
```

## Testing

```
[ ] Redis service tests pass
[ ] Redis health tests pass
[ ] configuration tests pass
[ ] full test suite passes
[ ] npm run build passes
```

---

# 68. Questions You Must Answer

Before moving to the next lecture, you should be able to explain:

### Question 1

What is the difference between:

```
connect
```

and:

```
ready
```

?

---

### Question 2

What happens when Redis disconnects while the API is running?

---

### Question 3

What is:

```
retryStrategy
```

?

---

### Question 4

Why do we use backoff?

---

### Question 5

Why is a retry cap useful?

---

### Question 6

What is a thundering herd?

---

### Question 7

Why does `/health/live` remain `200` when Redis is down?

---

### Question 8

Why does `/health/ready` become `503`?

---

### Question 9

Why should we not register Redis event listeners every time `connectRedis()` is called?

---

### Question 10

What is the difference between:

```
connection retry
```

and:

```
job retry
```

?

---

# 69. Important Concept

At this point we have:

```
Redis
```

but we are not treating it as:

```
magic infrastructure
```

We now understand:

```
Redis
  │
  ├── connection
  ├── readiness
  ├── failure
  ├── recovery
  ├── retry
  └── lifecycle
```

That is the mindset needed for distributed systems.

---

# 70. Success Criteria

Lecture 3 is complete only when:

```
[✓] Redis connects during startup
[✓] Redis connection is logged
[✓] Redis ready state is observable
[✓] Redis errors are logged
[✓] Redis reconnects after runtime failure
[✓] Redis readiness becomes unhealthy during failure
[✓] Redis readiness recovers
[✓] Redis startup failure is observable
[✓] Redis configuration failure is handled
[✓] Redis shuts down cleanly
[✓] PostgreSQL still works
[✓] API still works
[✓] liveness remains independent
[✓] Redis tests pass
[✓] health tests pass
[✓] full test suite passes
[✓] TypeScript build passes
```

---

# 71. What We Have Now

The progression is:

```
Lecture 1
Redis Setup
    │
    ▼
Lecture 2
Redis Data Structures
    │
    ▼
Lecture 3
Redis Reliability
    │
    ▼
NEXT
BullMQ
```

We have deliberately built the foundation before introducing the queue abstraction.

---

# 72. Next Lecture

# Module 2 — Lecture 4

## BullMQ Architecture & First Queue

Only now will we introduce:

```
BullMQ
   │
   ▼
Queue
   │
   ▼
Producer
   │
   ▼
Redis
   │
   ▼
Worker
```

We will build the smallest possible production-style queue first:

```
API
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
```

Then we will:

```
enqueue one job
process one job
inspect the job
verify Redis state
test worker failure
restart worker
verify job behavior
```

We will **not** jump directly into retries, delayed jobs, priorities, concurrency, or dead-letter queues.

Those come only after the basic producer → queue → worker lifecycle is understood.
