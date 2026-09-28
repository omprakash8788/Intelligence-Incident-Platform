# Module 1 — Lecture 19: Health Checks vs Readiness

> **Project:** Production Intelligence & Incident Platform
>
> **Stack:** Node.js + TypeScript + Express + PostgreSQL
>
> **Architecture principle:** A production system must distinguish between "the process is alive" and "the application is ready to receive traffic."

---

# 1. What We Are Building

Our current application has:

```text
GET /health
```
and it currently checks PostgreSQL.

That is useful, but it mixes several different concepts.

In production, these are different questions:
```
Is the Node.js process alive?

Is the application ready to receive traffic?

Is PostgreSQL available?

Is the application starting?

Is the application shutting down?
```
We need to separate these concerns.

By the end of this lecture, we will have:
```
GET /health/live
GET /health/ready
```
The architecture will be:
```
  Load Balancer
                       │
                       ▼
              GET /health/ready
                       │
              ┌────────┴────────┐
              │                 │
              ▼                 ▼
        Application          PostgreSQL
           Ready?              Ready?
              │                 │
              └────────┬────────┘
                       ▼
                  200 / 503


              GET /health/live
                       │
                       ▼
                 Node Process
                       │
                       ▼
                     200

```

---

### 2. Why /health Is Not Enough

Suppose PostgreSQL goes down.

Our Node.js process can still be alive:
```
Node.js
   │
   ├── process alive
   ├── Express alive
   └── PostgreSQL unavailable
```
If our health endpoint says:
```
{
  "status": "ok"
}
```
a load balancer may think:
```
Application is healthy.
Send traffic.
```
But requests will fail because PostgreSQL is unavailable.

Therefore we need different checks.

---

### 3. Liveness

A **liveness check** answers:

`Is this process alive enough to continue running?`

Example:
```
GET /health/live
```
Response:
```
{
  "status": "ok"
}
```
HTTP:
```
200 OK
```
It should normally be lightweight.

It should **not** depend on PostgreSQL.

Why?

Because if PostgreSQL is down:
Why?

Because if PostgreSQL is down:
```
PostgreSQL DOWN
       │
       ▼
Liveness check
       │
       ▼
Node process still alive
       │
       ▼
200 OK
```
The process itself has not necessarily failed.

---

### 4. Readiness

A **readiness check** answers:

`Can this application currently accept production traffic?`

Example:
```
GET /health/ready
```
The readiness check can verify dependencies.

For our current architecture:
```
Application
     │
     └── PostgreSQL
```
So:
```
PostgreSQL available
       ↓
Application ready
       ↓
200 OK
```
But:
```
PostgreSQL unavailable
       ↓
Application not ready
       ↓
503 Service Unavailable
```

---

### 5. Why 503?

We use:
```
503 Service Unavailable
```
because the server is alive, but temporarily unable to serve the requested workload correctly.

This is different from:
```
500 Internal Server Error
```
A *500* generally indicates an unexpected application failure.

A *503* communicates:
```
Service exists,
but is currently unavailable for normal traffic.
```

---

### 6. Startup

There is another concept:
```
Startup
```
Imagine our application eventually needs to initialize:
```
Node.js
   ↓
Load configuration
   ↓
Connect PostgreSQL
   ↓
Connect Redis
   ↓
Initialize BullMQ
   ↓
Initialize workers
   ↓
Ready
```
During startup:
```
Application process = alive
Application = not ready
```
Therefore:
```
Liveness  → 200
Readiness → 503
```
until initialization is complete.

We will build more advanced startup state later.

---

### 7. Shutdown and Readiness

This is where Lecture 18 connects directly to Lecture 19.

During shutdown:
```
SIGTERM
   ↓
Application begins shutdown
```
The process is still alive.

But it should no longer receive new production traffic.

Therefore:
```
Liveness
   ↓
200

Readiness
   ↓
503
```
This is extremely important.

The lifecycle becomes:
```
STARTING
   │
   ▼
READY
   │
   │ SIGTERM
   ▼
SHUTTING_DOWN
   │
   ▼
STOPPED
```
And health behavior:
```
STARTING
  ├── live: 200
  └── ready: 503

READY
  ├── live: 200
  └── ready: 200

SHUTTING_DOWN
  ├── live: 200
  └── ready: 503

STOPPED
  └── no response
  ```

### 8. Current Health Implementation

Our current health controller checks PostgreSQL:
```
await checkDatabaseConnection();
```
That is not appropriate for liveness.

We will separate the endpoints.

---

### 9. Create Application Lifecycle State

Create:

`src/server/lifecycle.ts`

Complete file:

```
export type ApplicationState =
  | "starting"
  | "ready"
  | "shutting_down"
  | "stopped";

let applicationState: ApplicationState =
  "starting";

export const getApplicationState =
  (): ApplicationState => {
    return applicationState;
  };

export const markApplicationReady =
  (): void => {
    applicationState = "ready";
  };

export const markApplicationShuttingDown =
  (): void => {
    applicationState =
      "shutting_down";
  };

export const markApplicationStopped =
  (): void => {
    applicationState = "stopped";
  };
```

---

### 10. Why Do We Need Application State?

We need to know whether the application is:
```
starting
ready
shutting_down
stopped
```
Without this state, readiness cannot correctly respond during shutdown.

For example:
```
SIGTERM
   ↓
shutdown starts
   ↓
readiness endpoint
```
must return:
```
503
```
even if PostgreSQL is still available.

---

### 11. Update Server Startup

Our current `src/server.ts` starts the HTTP server.

We need to mark the application as ready after the server starts.

#### File
`src/server.ts`

Replace the complete file:

```
import app from "./app.js";

import { env } from "./config/env.js";

import { logger } from "./logging/logger.js";

import {
  markApplicationReady
} from "./server/lifecycle.js";

import {
  shutdown
} from "./server/shutdown.js";

const server =
  app.listen(
    env.port,
    () => {

      markApplicationReady();

      logger.info(
        "Server started",
        {
          port: env.port,
          environment:
            env.nodeEnv
        }
      );
    }
  );

process.on(
  "SIGINT",
  () => {
    void shutdown(
      server,
      "SIGINT"
    );
  }
);

process.on(
  "SIGTERM",
  () => {
    void shutdown(
      server,
      "SIGTERM"
    );
  }
);
```

---

### 12. Important Production Note

For our current application, startup is simple.

The server starts and we immediately mark:
```
ready
```
Later, when we introduce:
```
Redis
BullMQ
WebSockets
other dependencies
```
we will change this.

Eventually:
```
Application starts
       ↓
PostgreSQL initialized
       ↓
Redis initialized
       ↓
Queues initialized
       ↓
Workers initialized
       ↓
markApplicationReady()
```
So the readiness state becomes a genuine startup gate.

---

### 13. Create Liveness Controller
#### File
`src/controllers/health.controller.ts`

Replace the complete file with:
```
import {
  Request,
  Response,
  NextFunction
} from "express";

import {
  checkDatabaseConnection
} from "../database/health.js";

import {
  getApplicationState
} from "../server/lifecycle.js";

export const livenessController = (
  _req: Request,
  res: Response
) => {

  const state =
    getApplicationState();

  if (
    state === "stopped"
  ) {
    res.status(503).json({
      status: "unavailable",
      state
    });

    return;
  }

  res.status(200).json({
    status: "ok",
    state
  });
};

export const readinessController = async (
  _req: Request,
  res: Response
) => {

  const state =
    getApplicationState();

  if (
    state !== "ready"
  ) {
    res.status(503).json({
      status: "not_ready",
      state
    });

    return;
  }

  try {

    await checkDatabaseConnection();

    res.status(200).json({
      status: "ready",
      state,
      dependencies: {
        postgres: "connected"
      }
    });

  } catch (error) {

    res.status(503).json({
      status: "not_ready",
      state,
      dependencies: {
        postgres: "unavailable"
      }
    });
  }
};

export const healthController = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    await checkDatabaseConnection();

    res.status(200).json({
      status: "ok",
      service:
        "production-intelligence-platform",
      database: "connected"
    });

  } catch (error) {

    next(error);
  }
};
```

---

### 14. Why Keep healthController?

We are introducing:
```
/health/live
/health/ready
```
but the existing:
```
/health
```
may already be used by our existing tests or development workflow.

For now, we keep it.

Eventually we may decide to remove or redefine it.

For production infrastructure, however, we will use the explicit endpoints:
```
/health/live
/health/ready
```

---

### 15. Liveness Controller

The liveness endpoint does not call:
```
checkDatabaseConnection()
```
That is intentional.

It simply checks:
```
getApplicationState()
```
For example:
```
{
  "status": "ok",
  "state": "ready"
}
```
HTTP:
```
200
```
---

### 16. Readiness Controller

Readiness checks two things.

First:
```
Is application state ready?
```
Second:
```
Is PostgreSQL available?
```
Therefore:
```
Application ready
       +
PostgreSQL connected
       ↓
200
```
Otherwise:
```
503
```

---

### 17. Create Health Routes
#### File
`src/routes/health.routes.ts`

Replace the complete file with:
```
import {
  Router
} from "express";

import {
  healthController,
  livenessController,
  readinessController
} from "../controllers/health.controller.js";

const router = Router();

router.get(
  "/live",
  livenessController
);

router.get(
  "/ready",
  readinessController
);

router.get(
  "/",
  healthController
);

export default router;
```

---

### 18. Route Design

We now have:
```
GET /health/live
GET /health/ready
GET /health
```
Their responsibilities are different.

| Endpoint        | Purpose                      | PostgreSQL |
| --------------- | ---------------------------- | ---------- |
| `/health/live`  | Process/application liveness | No         |
| `/health/ready` | Traffic readiness            | Yes        |
| `/health`       | Existing application health  | Yes        |


---

### 19. Update Shutdown Lifecycle

Now we must connect Lecture 18 with our new lifecycle state.

When shutdown starts:
```
application state
```
must become:
```
shutting_down
```
When shutdown finishes:
```
application state
```
becomes:
```
stopped
```

---

### 20. Update shutdown.ts
#### File
`src/server/shutdown.ts`

Replace the complete file with:

```
import type {
  Server
} from "node:http";

import {
  pool
} from "../database/pool.js";

import {
  logger
} from "../logging/logger.js";

import {
  markApplicationShuttingDown,
  markApplicationStopped
} from "./lifecycle.js";

let isShuttingDown = false;

export const shutdown = async (
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

  isShuttingDown = true;

  markApplicationShuttingDown();

  logger.info(
    "Graceful shutdown started",
    {
      signal
    }
  );

  try {

    await new Promise<void>(
      (resolve, reject) => {

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

### 21. Why Mark shutting_down Before Closing HTTP?

We do:
```
markApplicationShuttingDown();
```
before:
```
server.close();
```
This is important.

Imagine:
```
SIGTERM
   ↓
shutdown begins
   ↓
server.close()
```
During this small period, readiness might still be called.

We want:
```
/health/ready
```
to immediately report:
```
503
```
Therefore:
```
shutting_down
```
must be set as early as possible.

---

### 22. Readiness During Shutdown

Before shutdown:
```
{
  "status": "ready",
  "state": "ready",
  "dependencies": {
    "postgres": "connected"
  }
}
```
HTTP:
```
200
```
After:
```
SIGTERM
```
we have:
```
{
  "status": "not_ready",
  "state": "shutting_down"
}
```
HTTP:
```
503
```
This tells the load balancer:
```
Do not send new traffic here.
```

---

### 23. Test Lifecycle State

Create:

`tests/server/lifecycle.test.ts`

Complete file:
```
import {
  describe,
  expect,
  it,
  beforeEach
} from "vitest";

import {
  getApplicationState,
  markApplicationReady,
  markApplicationShuttingDown,
  markApplicationStopped
} from "../../src/server/lifecycle.js";

describe(
  "application lifecycle",
  () => {

    beforeEach(() => {
      markApplicationReady();
    });

    it(
      "should start in a ready state for tests",
      () => {

        expect(
          getApplicationState()
        ).toBe("ready");
      }
    );

    it(
      "should transition to shutting_down",
      () => {

        markApplicationShuttingDown();

        expect(
          getApplicationState()
        ).toBe("shutting_down");
      }
    );

    it(
      "should transition to stopped",
      () => {

        markApplicationStopped();

        expect(
          getApplicationState()
        ).toBe("stopped");
      }
    );
  }
);

```

---

### 24. Important Testing Issue

The lifecycle state is module-level state:
```
let applicationState = "starting";
```
Tests can therefore affect one another.

We use:
```
beforeEach(() => {
  markApplicationReady();
});
```
to establish a known starting state.

This is a general testing principle:

`Tests should explicitly establish the state they depend upon.`

---

### 25. Test Health API

Create:

`tests/health/health.api.test.ts`

Complete file:

```
import {
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import app from "../../src/app.js";

describe(
  "Health API",
  () => {

    it(
      "should return 200 for liveness",
      async () => {

        const response =
          await request(app)
            .get("/health/live");

        expect(response.status)
          .toBe(200);

        expect(response.body.status)
          .toBe("ok");

        expect(response.body.state)
          .toBeDefined();
      }
    );

    it(
      "should return 200 for readiness when PostgreSQL is available",
      async () => {

        const response =
          await request(app)
            .get("/health/ready");

        expect(response.status)
          .toBe(200);

        expect(response.body)
          .toEqual({
            status: "ready",
            state: "ready",
            dependencies: {
              postgres: "connected"
            }
          });
      }
    );

    it(
      "should return the existing health response",
      async () => {

        const response =
          await request(app)
            .get("/health");

        expect(response.status)
          .toBe(200);

        expect(response.body.status)
          .toBe("ok");

        expect(
          response.body.service
        ).toBe(
          "production-intelligence-platform"
        );

        expect(
          response.body.database
        ).toBe("connected");
      }
    );
  }
);
```

---

### 26. Run Tests

Run:
```
npm run test:run
```
Then:
```
npm run build
```
Both should pass.

---

### 27. Test Readiness Without PostgreSQL

We need to test the failure scenario.

A readiness endpoint should return:
```
503
```
when PostgreSQL is unavailable.

We should not destroy our development database just to test this.

Instead, unit-test the controller by mocking:
```
checkDatabaseConnection()
```

---

### 28. Create Readiness Controller Tests

Create:

`tests/controllers/health.controller.test.ts`

Complete file:
```
import {
  describe,
  expect,
  it,
  vi,
  afterEach
} from "vitest";

import type {
  Request,
  Response
} from "express";

import {
  readinessController
} from "../../src/controllers/health.controller.js";

import {
  markApplicationReady
} from "../../src/server/lifecycle.js";

import {
  checkDatabaseConnection
} from "../../src/database/health.js";

vi.mock(
  "../../src/database/health.js",
  () => ({
    checkDatabaseConnection:
      vi.fn()
  })
);

describe(
  "readinessController",
  () => {

    afterEach(() => {
      vi.clearAllMocks();
    });

    it(
      "should return 200 when PostgreSQL is available",
      async () => {

        markApplicationReady();

        vi.mocked(
          checkDatabaseConnection
        ).mockResolvedValue({
          "?column?": 1
        });

        const status =
          vi.fn()
            .mockReturnThis();

        const json =
          vi.fn();

        const res = {
          status,
          json
        } as unknown as Response;

        await readinessController(
          {} as Request,
          res
        );

        expect(status)
          .toHaveBeenCalledWith(200);

        expect(json)
          .toHaveBeenCalledWith({
            status: "ready",
            state: "ready",
            dependencies: {
              postgres: "connected"
            }
          });
      }
    );

    it(
      "should return 503 when PostgreSQL is unavailable",
      async () => {

        markApplicationReady();

        vi.mocked(
          checkDatabaseConnection
        ).mockRejectedValue(
          new Error(
            "database unavailable"
          )
        );

        const status =
          vi.fn()
            .mockReturnThis();

        const json =
          vi.fn();

        const res = {
          status,
          json
        } as unknown as Response;

        await readinessController(
          {} as Request,
          res
        );

        expect(status)
          .toHaveBeenCalledWith(503);

        expect(json)
          .toHaveBeenCalledWith({
            status: "not_ready",
            state: "ready",
            dependencies: {
              postgres: "unavailable"
            }
          });
      }
    );
  }
);
```

---

### 29. Run the Tests

Run:
```
npm run test:run
```
We should now have tests covering:
```
Liveness
Readiness success
Readiness database failure
Lifecycle state
Request IDs
Graceful shutdown
Logging
Incidents
Errors
```

---

### 30. Test Readiness During Shutdown

We need another important scenario.

If the application state is:

```
shutting_down
```

readiness should return:
```
503
```
without even querying PostgreSQL.

Add this test to:
```
tests/controllers/health.controller.test.ts
```
Inside the existing *describe*, add:

```
it(
  "should return 503 during shutdown",
  async () => {

    const {
      markApplicationShuttingDown
    } =
      await import(
        "../../src/server/lifecycle.js"
      );

    markApplicationShuttingDown();

    const status =
      vi.fn()
        .mockReturnThis();

    const json =
      vi.fn();

    const res = {
      status,
      json
    } as unknown as Response;

    await readinessController(
      {} as Request,
      res
    );

    expect(status)
      .toHaveBeenCalledWith(503);

    expect(json)
      .toHaveBeenCalledWith({
        status: "not_ready",
        state: "shutting_down"
      });

    expect(
      checkDatabaseConnection
    ).not.toHaveBeenCalled();
  }
);
```
---

### 31. Test Again

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

### 32. Intentional Break #1

Now break liveness.

#### File
```
src/controllers/health.controller.ts
```
Temporarily change:
```
res.status(200).json({
```
inside *livenessController* to:
```
res.status(503).json({
```
Run:
```
npm run test:run
```
The liveness API test should fail.

Restore:
```
res.status(200).json({
```
Run:
```
npm run test:run
```
The test should pass.

---

### 33. Intentional Break #2

Now break readiness.

#### File
```
src/controllers/health.controller.ts
```
Temporarily change:
```
res.status(503).json({
```
inside the PostgreSQL failure branch to:
```
res.status(200).json({
```
Run:
```
npm run test:run
```
The database failure test should fail.

Restore:
```
res.status(503).json({
```
Run:
```
npm run test:run
```
Again, tests should pass.

---

### 34. Manual Test — Liveness

Start the application:
```
npm run dev
```
Run:
```
curl http://localhost:3000/health/live
```
Expected:
```
{
  "status": "ok",
  "state": "ready"
}
```
HTTP:
```
200
```

---

### 35. Manual Test — Readiness

Run:
```
curl http://localhost:3000/health/ready
```
Expected:
```
{
  "status": "ready",
  "state": "ready",
  "dependencies": {
    "postgres": "connected"
  }
}
```
HTTP:
```
200
```

---

### 36. Manual Test — Existing Health

Run:
```
curl http://localhost:3000/health
```
Expected:
```
{
  "status": "ok",
  "service": "production-intelligence-platform",
  "database": "connected"
}
```

---

### 37. Manual Test — Database Failure

Stop PostgreSQL:
```
docker compose stop postgres
```
Now call:
```
curl http://localhost:3000/health/ready
```
Expected:
```
{
  "status": "not_ready",
  "state": "ready",
  "dependencies": {
    "postgres": "unavailable"
  }
}
```
HTTP:
```
503
```
This is exactly what we want.

---

### 38. Test Liveness While PostgreSQL Is Down

With PostgreSQL still stopped:
```
curl http://localhost:3000/health/live
```
Expected:
```
{
  "status": "ok",
  "state": "ready"
}
```
HTTP:
```
200
```
This demonstrates the key difference.

PostgreSQL DOWN
```
Liveness  → 200
Readiness → 503
```
The Node.js process is alive.

The application is not ready to serve database-dependent production traffic.

---

### 39. Restart PostgreSQL

Run:
```
docker compose start postgres
```
Check:
```
docker compose ps
```
Then:
```
curl http://localhost:3000/health/ready
```
Expected:
```
{
  "status": "ready",
  "state": "ready",
  "dependencies": {
    "postgres": "connected"
  }
}
```

HTTP:
```
200
```

---

### 40. Important Observation

Notice something important.

When PostgreSQL went down:
```
applicationState = ready
```
was still true.

Readiness returned:
```
503
```
because the dependency failed.

This means readiness is based on:
```
Application state
        +
Required dependencies
```
not just application state.

---

### 41. Shutdown + Readiness

Now start the server again if necessary:
```
npm run dev
```
Call:
```
curl http://localhost:3000/health/ready
```
You should get:
```
200
```
Now press:
```
Ctrl + C
```
During shutdown, the state changes to:
```
shutting_down
```
and readiness becomes:
```
503
```

This is the behavior a production load balancer needs.

---

### 42. Why This Prevents Traffic to a Shutting-Down Instance

Imagine three application instances:
```
Instance A → ready
Instance B → ready
Instance C → ready
```
Traffic:
```
              Load Balancer
             /      |      \
            ▼       ▼       ▼
           A        B        C
```
Deployment starts.

Instance B receives:
```
SIGTERM
```
B changes:
```
ready → shutting_down
```
and readiness becomes:
```
503
```
The load balancer can remove B from traffic:
```
      Load Balancer
             /             \
            ▼               ▼
           A                 C

           B
      shutting down
```
Existing requests can finish before B exits.

This is one of the most important production uses of readiness checks.

---

### 43. Liveness vs Readiness Summary

| Property                | Liveness                        | Readiness               |
| ----------------------- | ------------------------------- | ----------------------- |
| Question                | Is process alive?               | Can it receive traffic? |
| Endpoint                | `/health/live`                  | `/health/ready`         |
| PostgreSQL              | No                              | Yes                     |
| During startup          | Usually 200                     | 503                     |
| During normal operation | 200                             | 200                     |
| During shutdown         | Usually 200 until process exits | 503                     |
| Purpose                 | Detect dead process             | Control traffic         |


---

### 44. What About Startup Probes?

Some production platforms distinguish:
```
Liveness
Readiness
Startup
```
Startup is useful when an application takes a long time to initialize.

Example:
```
Application starts
       ↓
Load configuration
       ↓
Connect PostgreSQL
       ↓
Connect Redis
       ↓
Load caches
       ↓
Initialize workers
       ↓
Ready
```
During this phase:
```
Liveness → 200
Readiness → 503
Startup → not yet complete
```

We don't need a separate startup endpoint yet.

Our lifecycle state gives us the foundation.

---

### 45. Why Not Make /health/live Check PostgreSQL?

This is a common mistake.

Bad design:
```
/health/live
    ↓
PostgreSQL
    ↓
database fails
    ↓
liveness = 503
```
Then the orchestrator may conclude:
```
Application is dead.
Restart it.
```
But the Node process might be perfectly healthy.

Restarting the process won't necessarily fix a database outage.

You can end up with:
```
PostgreSQL outage
       ↓
Instance restart
       ↓
PostgreSQL still down
       ↓
Instance restart
       ↓
PostgreSQL still down
       ↓
restart loop
```
This is called a cascading or restart-loop type failure pattern.

Liveness should therefore remain focused on the process/application itself.

---

### 46. Why Readiness Can Check PostgreSQL

Readiness has a different purpose.

If PostgreSQL is required for normal API operation:
```
PostgreSQL unavailable
        ↓
Application cannot safely serve requests
        ↓
Readiness = 503
```
This allows traffic routing infrastructure to stop sending traffic to that instance.

---

### 47. Future Dependencies

Today:
```
Application
    │
    └── PostgreSQL
```
Later:
```
Application
    │
    ├── PostgreSQL
    ├── Redis
    ├── BullMQ
    └── WebSocket infrastructure
```
Our readiness check may eventually become:
```
Application state
      │
      ├── PostgreSQL
      ├── Redis
      └── Queue infrastructure
```
But we should be careful.

Not every dependency must necessarily make the entire application unready.

For example:
```
Analytics Redis
```
might be optional.

Whereas:
```
Primary PostgreSQL
```
might be mandatory.

This leads to dependency classification later.

---

### 48. Critical vs Optional Dependencies

Eventually we can define:
```
Critical dependencies
---------------------
PostgreSQL
```
and:
```
Optional dependencies
---------------------
Analytics cache
Metrics exporter
Non-critical external service
```
Then readiness can use rules like:
```
PostgreSQL DOWN
    ↓
NOT READY

Optional cache DOWN
    ↓
READY
```
This prevents overreacting to non-critical failures.

---

### 49. Current Architecture After Lecture 19

Our lifecycle is now:
```
                 Application
                      │
             ┌────────┴────────┐
             │                 │
             ▼                 ▼
        Liveness           Readiness
             │                 │
             │                 ├── State
             │                 │
             │                 └── PostgreSQL
             │
             ▼
        Process alive
```
And lifecycle:

```
STARTING
   │
   ▼
READY
   │
   │ SIGTERM
   ▼
SHUTTING_DOWN
   │
   ▼
STOPPED
```

---

### 50. Final Folder Structure

After Lecture 19:

```
production-intelligence-platform/
│
├── src/
│   │
│   ├── config/
│   │   └── env.ts
│   │
│   ├── controllers/
│   │   ├── health.controller.ts
│   │   └── incident.controller.ts
│   │
│   ├── database/
│   │   ├── migrations/
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
│   │   └── validation.middleware.ts
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
│   │
│   ├── controllers/
│   │   └── health.controller.test.ts
│   │
│   ├── logging/
│   │   ├── logger.test.ts
│   │   ├── request-context.test.ts
│   │   └── request-logging.middleware.test.ts
│   │
│   ├── middleware/
│   │   └── request-id.middleware.test.ts
│   │
│   ├── server/
│   │   ├── lifecycle.test.ts
│   │   └── shutdown.test.ts
│   │
│   ├── health/
│   │   └── health.api.test.ts
│   │
│   ├── request-id.api.test.ts
│   ├── request-id.error.api.test.ts
│   └── ...
│
├── .env
├── .gitignore
├── docker-compose.yml
├── package.json
└── tsconfig.json
```
