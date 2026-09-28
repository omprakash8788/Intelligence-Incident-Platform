### Module 1 — Lecture 18: Graceful Shutdown

> **Project:** Production Intelligence & Incident Platform
>
> **Stack:** Node.js + TypeScript + Express + PostgreSQL
>
> **Architecture principle:** A production service must shut down deliberately, not abruptly.

---

# 1. What We Are Building

So far our application can:

- start an HTTP server
- connect to PostgreSQL
- execute database queries
- process API requests
- log structured events
- generate request IDs
- propagate request context
- handle application errors

But there is an important production problem.

What happens if we execute:

```bash
Ctrl + C
```
or the server receives:
```
SIGTERM
```
Currently Node.js can terminate the process while requests or database operations are still running.

That can cause:

- incomplete HTTP requests
- interrupted database queries
- partially completed operations
- dropped logs
- broken transactions
- unfinished background work
- inconsistent application state

We need **graceful shutdown**.

---

### 2. What Is Graceful Shutdown?

Graceful shutdown means:

**Stop accepting new work, allow existing work to finish when possible, close resources, and then terminate the process.**

Instead of:
```
SIGTERM
   ↓
process.exit()
   ↓
💥 application immediately dies
```
we want:

```
SIGTERM
   ↓
Stop accepting new requests
   ↓
Allow active requests to finish
   ↓
Close HTTP server
   ↓
Close PostgreSQL pool
   ↓
Close Redis later
   ↓
Close queues/workers later
   ↓
Exit process
```
---

### 3. Why This Matters in Production

Imagine our API is processing:
```
POST /incidents
```
At the exact same moment Kubernetes sends:
```
SIGTERM
```
If we immediately terminate:
```
process.exit(0)
```
the request might be interrupted.
```
For example:
HTTP Request
     │
     ▼
Incident Controller
     │
     ▼
Incident Service
     │
     ▼
PostgreSQL
     │
     ├── INSERT incident
     │
     └── INSERT event
              │
              X
          Process dies
```
That is dangerous.

A production service should instead finish the current operation whenever possible.

---

### 4. Signals We Need to Understand

Operating systems send signals to processes.

The most important ones for our application are:
```
SIGINT
SIGTERM
```
#### SIGINT

Usually generated when you press:
```
Ctrl + C
```
For example:
```
npm run dev
```
then:
```
Ctrl + C
```
Node receives:
```
SIGINT
```

--- 

#### SIGTERM

**SIGTERM** means:
```
Terminate gracefully
```
This is especially important in:

- Docker
- Kubernetes
- ECS
- cloud platforms
- process managers
- deployment systems

For example:
```
Kubernetes
     │
     │ SIGTERM
     ▼
Node.js application
```
---

### 5. SIGKILL Is Different

There is also:
```
SIGKILL
```
The operating system does not allow the application to handle **SIGKILL**.

You cannot do:
```
process.on("SIGKILL", ...)
```
and expect graceful cleanup.

Therefore:
```
SIGTERM
```
is the important signal for graceful shutdown.

---

### 6. Current Server Problem

Our current server is approximately:

#### File
```
src/server.ts
```
```
import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./logging/logger.js";

app.listen(env.port, () => {
  logger.info(
    "Server started",
    {
      port: env.port,
      environment: env.nodeEnv
    }
  );
});
```
The problem is:
```
app.listen()
```
creates an HTTP server, but we don't keep a reference to it.

Therefore we cannot properly tell the HTTP server:
```
stop accepting new connections
```
We need to change that.

---

### 7. Architecture We Want

Our server lifecycle will become:

```
                Application Start
                       │
                       ▼
                Create HTTP Server
                       │
                       ▼
                Start Listening
                       │
                       ▼
                 Application
                    Running
                       │
             SIGINT / SIGTERM
                       │
                       ▼
              Begin Shutdown
                       │
                       ▼
             Stop HTTP Server
                       │
                       ▼
          Wait for active requests
                       │
                       ▼
             Close PostgreSQL
                       │
                       ▼
              Shutdown Complete
                       │
                       ▼
                  Exit process
```

---

### 8. First Important Change

We need the actual HTTP server object.

Node's:
```
app.listen()
```
returns:
```
http.Server
```
Therefore:
```
const server = app.listen(...)
```
allows us to later call:
```
server.close()
```

---

### 9. Create Server Lifecycle Module

We don't want all shutdown logic inside **server.ts**.

We will create a dedicated lifecycle module.

#### File
```
src/server/shutdown.ts
```
Create the directory if necessary:
```
src/server/
```
Create:
```
src/server/shutdown.ts
```
Complete file:
```
import type { Server } from "node:http";

import { pool } from "../database/pool.js";
import { logger } from "../logging/logger.js";

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

### 10. Understand server.close()

The important operation is:
```
server.close()
```
It tells Node:
```
Stop accepting new connections.
```
Existing connections can continue.

Conceptually:
```
Before shutdown:

Request A ────────────────┐
Request B ──────────┐     │
Request C ─────┐    │     │
               │    │     │
               ▼    ▼     ▼
             Server accepting requests


After server.close():

Request A ────────────────┐
Request B ──────────┐     │
Request C ─────┐    │     │
               │    │     │
               ▼    ▼     ▼

New Request D ──X
```
This is the fundamental graceful-shutdown behavior.

---

### 11. Why Does server.close() Return a Promise Here?

Node's **server.close()** uses a callback:
```
server.close((error) => {
  ...
});
```
We convert that callback into a Promise:
```
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
```
Now our shutdown flow can use:
```
await
```
which makes the order explicit:
```
close HTTP
     ↓
close PostgreSQL
     ↓
finish shutdown
```

---

### 12. Why isShuttingDown Exists

Signals can potentially arrive more than once.

For example:
```
SIGTERM
SIGTERM
SIGINT
```
Without protection, we could execute:
```
server.close()
```
multiple times.

Therefore:
```
let isShuttingDown = false;
```
and:
```
if (isShuttingDown) {
  return;
}
```
makes shutdown idempotent.

---

### 13. Shutdown Must Be Ordered

Our current resources are:
```
HTTP server
PostgreSQL pool
```
We close them in this order:
```
1. HTTP server
2. PostgreSQL pool
```
Why?

Because if we close PostgreSQL first:
```
PostgreSQL closed
     ↓
HTTP request still running
     ↓
request tries database
     ↓
database unavailable
```
That is undesirable.

Instead:
```
Stop accepting new HTTP work
        ↓
Existing HTTP work finishes
        ↓
Close PostgreSQL
```

---

### 14. Update server.ts

Now we need to use the shutdown module.

#### File
```
src/server.ts
```
Replace the entire file with:

```
import app from "./app.js";

import { env } from "./config/env.js";

import { logger } from "./logging/logger.js";

import { shutdown } from "./server/shutdown.js";

const server =
  app.listen(
    env.port,
    () => {

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

### 15. Why Do We Use void shutdown()?

The event handler is:
```
process.on(
  "SIGTERM",
  () => {
    void shutdown(...);
  }
);
```
**shutdown()** returns a Promise.

We intentionally start the asynchronous shutdown process without returning that Promise from the event callback.

The shutdown function itself handles:
```
success
failure
```
and sets:
```
process.exitCode
```
accordingly.

---

### 16. Important Difference: process.exit() vs process.exitCode

Avoid doing this immediately:
```
process.exit(0);
```
because it can terminate the process before asynchronous cleanup finishes.

Instead:
```
process.exitCode = 0;
```
allows Node to finish pending work and then exit naturally.

Similarly:
```
process.exitCode = 1;
```
indicates failure.

---

### 17. Test the Build

Run:
```
npm run build
```
Expected:
```
tsc
```
with no errors.

If TypeScript reports an error related to:
```
node:http
```
make sure **@types/node** is installed.

It should already be installed in our project.

If needed:
```
npm install -D @types/node
```

---

### 18. Run Existing Tests

Run:
```
npm run test:run
```
All previous tests should still pass.

We have changed the server lifecycle, but our API tests import:
```
app
```
rather than starting:
```
server
```
This distinction is important.

---

### 19. Why Tests Should Import app

Our architecture has two different responsibilities.

*app.ts*

Responsible for:
```
Express application
routes
middleware
error handling
```
*server.ts*

Responsible for:
```
HTTP server
network listener
signals
shutdown
```
Therefore tests can use:
```
import app from "../src/app.js";
```
without starting a real network server.

This makes tests cleaner.

---

### 20. Add Shutdown Unit Tests

Create:
```
tests/server/shutdown.test.ts
```
Complete file:

```
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach
} from "vitest";

import {
  shutdown
} from "../../src/server/shutdown.js";

import {
  pool
} from "../../src/database/pool.js";

import {
  logger
} from "../../src/logging/logger.js";

describe(
  "shutdown",
  () => {

    beforeEach(() => {

      vi.spyOn(
        logger,
        "info"
      ).mockImplementation(
        () => {}
      );

      vi.spyOn(
        logger,
        "warn"
      ).mockImplementation(
        () => {}
      );

      vi.spyOn(
        logger,
        "error"
      ).mockImplementation(
        () => {}
      );

      vi.spyOn(
        pool,
        "end"
      ).mockResolvedValue();

      vi.spyOn(
        process,
        "exit"
      ).mockImplementation(
        (() => {}) as never
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "should close the HTTP server and database pool",
      async () => {

        const server = {
          close: vi.fn(
            (
              callback: (
                error?: Error
              ) => void
            ) => {
              callback();
            }
          )
        };

        await shutdown(
          server as any,
          "SIGTERM"
        );

        expect(
          server.close
        ).toHaveBeenCalledTimes(1);

        expect(
          pool.end
        ).toHaveBeenCalledTimes(1);

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "HTTP server closed"
        );

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "PostgreSQL connection pool closed"
        );

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "Graceful shutdown completed"
        );
      }
    );
  }
);
```

---

### 21. Important Problem With Shutdown Tests

There is a subtle issue here.

Our module has:
```
let isShuttingDown = false;
```
That state survives between tests because modules are cached.

Therefore, if we test multiple shutdown scenarios, one test can affect another.

This is a real example of why lifecycle state needs careful design.

For this lecture we will keep the state private and test the primary successful shutdown path first.

Later, when the application becomes more complex, we can extract a testable lifecycle manager.

---

### 22. Run Tests

Run:
```
npm run test:run
```
Expected:
```
PASS
```
Your exact number of tests will depend on the current project state.

---

### 23. Intentional Break #1

Now let's prove the shutdown test actually protects the behavior.

#### File
```
src/server/shutdown.ts
```
Temporarily change:
```
await pool.end();
```
to:
```
// await pool.end();
```
Run:
```
npm run test:run
```
The shutdown test should fail because:
```
PostgreSQL connection pool closed
```
is no longer actually happening.

Restore:
```
await pool.end();
```
Run:
```
npm run test:run
```
The test should pass again.

---

### 24. Manual Shutdown Test

Start the application:
```
npm run dev
```
You should see:
```
Server started
```
Now press:
```
Ctrl + C
```
You should see logs similar to:
```
Graceful shutdown started
HTTP server closed
PostgreSQL connection pool closed
Graceful shutdown completed
```
The exact timestamp and JSON formatting will depend on the logger.

---

### 25. Test SIGTERM Manually on Windows

Because you are developing on Windows, **Ctrl + C** naturally exercises:
```
SIGINT
```
Testing **SIGTERM** can be done using another terminal.

First start:
```
npm run dev
```
For a production-like Node process, build first:
```
npm run build
```
then:
```
npm start
```
Find the process:
```
Get-Process node
```
You can inspect the process ID:
```
Get-Process node | Select-Object Id,ProcessName
```
Windows signal behavior differs from Linux containers, so don't treat local Windows signal behavior as identical to Kubernetes.

Later, when we Dockerize the application, we will test the actual:
```
SIGTERM
```
container lifecycle.

---

### 26. Test Active Requests

Graceful shutdown becomes more interesting when a request takes time.

For this experiment, we will temporarily add a test endpoint.

Do not keep this endpoint permanently.

#### File

*src/routes/health.routes.ts*

Temporarily add a route such as:

```

router.get(
  "/slow",
  async (_req, res) => {

    await new Promise(
      (resolve) => {
        setTimeout(
          resolve,
          5000
        );
      }
    );

    res.status(200).json({
      status: "ok",
      message: "Slow request completed"
    });
  }
);
```
The exact import/router structure should match your existing **health.routes.ts**.

---

### 27. Run the Slow Request

Start:
```
npm run dev
```
Then call:
```
curl http://localhost:3000/health/slow
```
Immediately press:
```
Ctrl + C
```
The important concept is:
```
shutdown starts
       ↓
server stops accepting NEW requests
       ↓
existing request continues
       ↓
slow request finishes
       ↓
server closes
       ↓
database pool closes
```
This is graceful shutdown.

---

### 28. Remove the Temporary Slow Route

Do not leave test-only infrastructure in production code.

Remove:
```
/health/slow
```
from:
```
src/routes/health.routes.ts
```
Then run:
```
npm run build
```
and:
```
npm run test:run
```

---

### 29. Important Limitation of server.close()

**server.close()** waits for existing connections.

But imagine a request hangs forever:
```
Request
   ↓
Database
   ↓
external service
   ↓
never responds
```
Then graceful shutdown might wait indefinitely.

That's why production systems often use:
```
Graceful shutdown timeout
```
For example:

```
SIGTERM
   ↓
graceful shutdown
   ↓
wait up to 30 seconds
   ↓
if still active
   ↓
force shutdown
```
We are **not implementing the forced timeout yet**.

That will be part of the production hardening work later.

---

### 30. Why We Don't Add a Timeout Yet

A common beginner implementation is:
```
setTimeout(() => {
  process.exit(1);
}, 5000);
```
immediately.

That is dangerous because:
```
5 seconds
```
is an arbitrary decision.

We first need to understand:

- what resources we have
- how long requests normally take
- how database operations behave
- how workers behave
- how queues behave
- how deployment infrastructure sends termination signals

Later we will establish a proper shutdown deadline.

---

### 31. Current Resource Lifecycle

Our application currently owns:
```
HTTP Server
     │
     └── Express application

PostgreSQL Pool
     │
     └── Database connections
```
Shutdown:
```
SIGINT/SIGTERM
       │
       ▼
HTTP Server close
       │
       ▼
PostgreSQL Pool end
       │
       ▼
Process exits
```
Later this will become:
```
HTTP Server
     │
     ▼
WebSocket Server
     │
     ▼
BullMQ Workers
     │
     ▼
Redis
     │
     ▼
PostgreSQL
```
The shutdown sequence will become more important as our architecture grows.

---

### 32. Future Architecture

Eventually:

```
 SIGTERM
                    │
                    ▼
           ┌─────────────────┐
           │ Shutdown Manager│
           └────────┬────────┘
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
   Stop HTTP    Stop Workers   Stop WebSocket
        │           │            │
        ▼           ▼            ▼
   Finish API    Finish Jobs   Finish Clients
        │           │            │
        └───────────┼────────────┘
                    ▼
                  Redis
                    │
                    ▼
               PostgreSQL
                    │
                    ▼
                  Exit


```

This is why we are learning graceful shutdown now, before introducing Redis and BullMQ.

---

### 33. Graceful Shutdown and Transactions

Remember our transaction architecture:
```
BEGIN
  │
  ├── INSERT incident
  │
  ├── INSERT incident event
  │
  ▼
COMMIT
```
If shutdown occurs while a transaction is running, PostgreSQL will eventually clean up the connection when the process disappears.

But we don't want to intentionally rely on process termination.

Graceful shutdown gives active requests an opportunity to finish:
```
HTTP request
     ↓
transaction
     ↓
COMMIT
     ↓
HTTP response
     ↓
shutdown
```
That is much safer.

---

### 34. Graceful Shutdown Is Not the Same as Application Health

This distinction will become important in the next lectures.

During normal operation:
```
Application
    │
    ├── accepting requests
    ├── database available
    └── ready for traffic
```
During shutdown:
```
Application
    │
    ├── stopping
    ├── not accepting new traffic
    └── finishing existing work
```
A load balancer should eventually stop sending new traffic before the process disappears.

This leads directly into:
```
Readiness
```
which we will study next.

---

### 35. Production Deployment Lifecycle

A typical deployment can look like:

```
Old Instance
     │
     │ receives SIGTERM
     ▼
Stop accepting traffic
     │
     ▼
Finish active requests
     │
     ▼
Close resources
     │
     ▼
Exit

New Instance
     │
     ▼
Start
     │
     ▼
Health checks
     │
     ▼
Ready
     │
     ▼
Receive traffic
```
This is one of the reasons graceful shutdown is fundamental to production systems.

---


### 36. Final File Structure

After Lecture 18, the important structure should look like:

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
│   ├── logging/
│   │   ├── logger.test.ts
│   │   ├── request-context.test.ts
│   │   └── request-logging.middleware.test.ts
│   │
│   ├── middleware/
│   │   └── request-id.middleware.test.ts
│   │
│   ├── server/
│   │   └── shutdown.test.ts
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

---

### 37. Final Commands

Build:
```
npm run build
```
Run all tests:
```
npm run test:run
```
Start development server:
```
npm run dev
```
Start production build:
```
npm run build
npm start
```
