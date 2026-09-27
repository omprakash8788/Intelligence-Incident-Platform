### Module 1 — Lecture 16
### Structured Logging

This lecture introduces ***production-grade structured logging.***

We currently have things like:

```
console.log(...)
console.error(...)
```

That becomes difficult to operate once our platform has:

- API requests
- PostgreSQL
- Redis
- BullMQ workers
- incident detection
- event processing
- multiple services

We need logs that are machine-readable and searchable.

Our target:
```
{
  "timestamp": "2026-09-27T10:20:30.000Z",
  "level": "info",
  "service": "production-intelligence-platform",
  "message": "Incident created",
  "incidentId": "..."
}
```

---

### Part 1 — Current project structure

Before changing anything, this is the structure we are working toward.

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
│   ├── middleware/
│   │   ├── error.middleware.ts
│   │   ├── not-found.middleware.ts
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
│   ├── services/
│   │   └── incident.service.ts
│   │
│   ├── types/
│   │   └── api-response.ts
│   │
│   ├── utils/
│   │   └── api-response.ts
│   │
│   ├── app.ts
│   ├── container.ts
│   └── server.ts
│
├── tests/
│   ├── errors/
│   ├── services/
│   ├── health.api.test.ts
│   ├── incidents.api.test.ts
│   └── ...
│
├── .env
├── .gitignore
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

We're going to add:

```
src/
└── logging/
    ├── logger.ts
    ├── log-level.ts
    └── request-context.ts

```

And tests:

```
tests/
└── logging/
    └── logger.test.ts

```
---

### Part 2 — What is structured logging?

Traditional logging:

```
Incident created payment-service critical
```

A human can read it.

But machines have difficulty reliably extracting:

```
incidentId
service
severity
timestamp

```

Structured logging instead produces:

```

{
  "timestamp": "2026-09-27T10:20:30.000Z",
  "level": "info",
  "service": "production-intelligence-platform",
  "message": "Incident created",
  "incidentId": "123"
}

```

Now a log system can easily query:

```
level = error
```

or:

```
incidentId = 123
```
or:
```
service = payment-service
```

---

### Part 3 — Log levels

We'll support:

```
debug
info
warn
error
```

Conceptually:

### debug

Detailed information useful during development.

```
Database query parameters
internal state
```

### info

Normal application activity.

```
Server started
Incident created
Request completed
```

### warn

Something unusual happened, but the application can continue.

```
Slow request
Retry occurring
Deprecated behavior

```

### error

Something failed.

```
Database failure
Unhandled exception
External service failure
```

We'll eventually add more sophisticated logging policies.

---

### Part 5 — Define log levels
### File to create

```
src/logging/log-level.ts
```

Use this complete file:

```
export const LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error"
] as const;

export type LogLevel =
  (typeof LOG_LEVELS)[number];

```

This gives us:

```
LogLevel

```

which can only be:

```
debug
info
warn
error

```
---

### Part 6 — Define request context

Eventually every HTTP request should have a request ID.

For example:
```
Request A
requestId = req-123

Request B
requestId = req-456
```

If Request A causes an error:

```
{
  "requestId": "req-123",
  "level": "error"
}
```

we can trace that request through the system.

For now we're creating the type/context structure. The actual request-ID middleware will be properly implemented in **Lecture 17.**

### File to create
```
src/logging/request-context.ts
```

Use:

```
export interface RequestContext {
  requestId?: string;
}
```

Notice that `requestId` is optional for now.

Why?
Because not every log necessarily originates from an HTTP request.

Later we will have:
```
HTTP request
BullMQ worker
scheduled job
event consumer
database process
```

A worker may have a:
```
jobId
```

rather than an HTTP request ID.

---

### Part 7 — Create the logger

Now we'll build the actual logger.

### File to create
```
src/logging/logger.ts
```

Use this complete file:

```
import type { LogLevel } from "./log-level.js";
import type { RequestContext } from "./request-context.js";

export interface LogMetadata {
  requestId?: string;
  incidentId?: string;
  service?: string;
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  metadata?: LogMetadata;
}

const APPLICATION_NAME =
  "production-intelligence-platform";

const writeLog = (
  level: LogLevel,
  message: string,
  metadata?: LogMetadata
) => {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: APPLICATION_NAME,
    message,
    ...(metadata
      ? { metadata }
      : {})
  };

  const serialized = JSON.stringify(entry);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
};

export const logger = {
  debug(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "debug",
      message,
      metadata
    );
  },

  info(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "info",
      message,
      metadata
    );
  },

  warn(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "warn",
      message,
      metadata
    );
  },

  error(
    message: string,
    metadata?: LogMetadata
  ) {
    writeLog(
      "error",
      message,
      metadata
    );
  }
};
```

---

### Part 8 — Understand the logger

When we call:

### Example
```
logger.info(
  "Incident created",
  {
    incidentId: "123",
    service: "payment-service"
  }
);
```

The logger generates approximately:

```
{
  "timestamp": "2026-09-27T10:20:30.000Z",
  "level": "info",
  "service": "production-intelligence-platform",
  "message": "Incident created",
  "metadata": {
    "incidentId": "123",
    "service": "payment-service"
  }
}
```


That is structured logging.

---

### Part 9 — Why metadata is an object

Don't do this:
```
logger.info(
  `Incident ${incidentId} created for ${service}`
);
```

Prefer:

```
logger.info(
  "Incident created",
  {
    incidentId,
    service
  }
);

```

Why?

Because a log processor can search:

```
incidentId = abc123
```

instead of trying to parse a string.

This becomes extremely important when our platform starts processing thousands of incidents.

---


### Part 10 — Add logger to the server

Now we'll replace our server startup `console.log.`

### File to modify
```
src/server.ts
```

**Action:** Replace the entire file with:

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

Now we have:

```
Server startup
      ↓
Structured logger
      ↓
JSON log
```

---

### Part 11 — Add logging to the error middleware

Our error middleware currently uses:

```
console.error(err);
```

We don't want that anymore.

### File to modify
```
src/middleware/error.middleware.ts
```

**Action:** Replace the entire file with:

```
import {
  Request,
  Response,
  NextFunction
} from "express";

import { AppError } from "../errors/AppError.js";
import { logger } from "../logging/logger.js";
import type { ApiErrorResponse } from "../types/api-response.js";

export const errorMiddleware = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {

  if (err instanceof AppError) {

    logger.warn(
      "Application error",
      {
        method: req.method,
        path: req.originalUrl,
        code: err.code,
        statusCode: err.statusCode,
        message: err.message
      }
    );

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: err.code,
        message: err.message
      }
    };

    res
      .status(err.statusCode)
      .json(response);

    return;
  }

  logger.error(
    "Unhandled application error",
    {
      method: req.method,
      path: req.originalUrl,
      error:
        err instanceof Error
          ? err.message
          : String(err)
    }
  );

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error"
    }
  });
};
```

---

### Part 12 — Why warn for AppError?

Consider:
```
GET /incidents/does-not-exist
```

Our service throws:

```
Incident not found

```

That's an expected application-level condition.

It isn't necessarily a server failure.

So:

```
404 → warn
500 → error
```

This distinction becomes useful when operating production systems.

If we logged every 404 as an error, our error logs could become extremely noisy.


---

### Part 13 — Log incident creation

Now let's add a useful business event log.

### File to modify
```
src/services/incident.service.ts
```

We don't want to rewrite the entire service blindly because it already contains the dependency injection from Lecture 10.

Add this import near the top:
```
import { logger } from "../logging/logger.js";
```

Then inside `createIncidentWithEvent(),` after the event has successfully been created, add:

```
logger.info(
  "Incident created",
  {
    incidentId: incident.id,
    service: incident.service,
    severity: incident.severity,
    status: incident.status
  }
);

```

So the relevant method should look like this:

```
async createIncidentWithEvent(
  input: CreateIncidentInput
): Promise<Incident> {

  return withTransaction(async (client) => {

    const incident =
      await this.incidentRepository.createWithClient(
        client,
        {
          service: input.service,
          severity: input.severity,
          status: "detected"
        }
      );

    await this.incidentEventRepository.create(
      client,
      {
        incidentId: incident.id,
        eventType: "INCIDENT_CREATED"
      }
    );

    logger.info(
      "Incident created",
      {
        incidentId: incident.id,
        service: incident.service,
        severity: incident.severity,
        status: incident.status
      }
    );

    return incident;
  });
}
```

---

### Part 14 — Important transaction consideration

Notice where we placed the log:

```
Create incident
      ↓
Create event
      ↓
logger.info()
      ↓
COMMIT

```

There's a subtle issue here.

The logger writes outside PostgreSQL's transaction system.

If:
```
incident inserted
event inserted
logger called
COMMIT fails

```

the log could say:

```
Incident created
```

even though the transaction ultimately rolled back.

For now, we're keeping logging simple.

Later, when we build more sophisticated event-driven architecture, we'll discuss how the `Outbox Pattern `solves this type of consistency problem.

That is one reason we are learning these concepts in this order.

---

### Part 15 — Request logging

We also want to know:

```
Which request happened?
How long did it take?
What HTTP status was returned?
```

We'll create middleware.

### File to create
```
src/middleware/request-logging.middleware.ts
```

Use:

```
import {
  Request,
  Response,
  NextFunction
} from "express";

import { logger } from "../logging/logger.js";

export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const startedAt = Date.now();

  res.on("finish", () => {

    const durationMs =
      Date.now() - startedAt;

    logger.info(
      "HTTP request completed",
      {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs
      }
    );
  });

  next();
};
```

---

### Part 16 — Register request logging middleware

This is important.

Creating middleware isn't enough.

We must actually register it.

### File to modify

```
src/app.ts
```

`Action:` Replace the entire file with:

```
import express from "express";

import healthRoutes from "./routes/health.routes.js";
import incidentRoutes from "./routes/incident.routes.js";

import { notFoundMiddleware } from "./middleware/not-found.middleware.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { requestLoggingMiddleware } from "./middleware/request-logging.middleware.js";

const app = express();

app.use(express.json());

app.use(requestLoggingMiddleware);

app.use("/health", healthRoutes);
app.use("/incidents", incidentRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
```

The order matters.

We have:

```
express.json()
      ↓
request logging
      ↓
routes
      ↓
404
      ↓
error handler

```

---

### Part 17 — Why request logging comes before routes

Suppose:

```
GET /incidents
```

If request logging comes after:

```
app.use("/incidents", incidentRoutes);
```

the request might not be observed correctly for all paths.

We want the middleware to wrap the request lifecycle:

```
Request
   ↓
Logging middleware
   ↓
Route
   ↓
Response
   ↓
finish event
   ↓
Log

```

---

### Part 18 — Test logger directly

Now we'll write a unit test.

### Folder to create
```
tests/
```
### File to create
```
tests/logger.test.ts

```

Use:

```
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach
} from "vitest";

import { logger } from "../src/logging/logger.js";

describe("logger", () => {

  beforeEach(() => {
    vi.spyOn(
      console,
      "log"
    ).mockImplementation(() => {});

    vi.spyOn(
      console,
      "warn"
    ).mockImplementation(() => {});

    vi.spyOn(
      console,
      "error"
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should write a structured info log", () => {

    logger.info(
      "Test message",
      {
        incidentId: "incident-123"
      }
    );

    expect(
      console.log
    ).toHaveBeenCalledTimes(1);

    const call =
      vi.mocked(console.log)
        .mock.calls[0][0];

    const entry =
      JSON.parse(String(call));

    expect(entry.level)
      .toBe("info");

    expect(entry.message)
      .toBe("Test message");

    expect(entry.service)
      .toBe(
        "production-intelligence-platform"
      );

    expect(
      entry.metadata.incidentId
    ).toBe("incident-123");

    expect(entry.timestamp)
      .toBeDefined();
  });

  it("should write errors using console.error", () => {

    logger.error(
      "Something failed",
      {
        incidentId: "incident-123"
      }
    );

    expect(
      console.error
    ).toHaveBeenCalledTimes(1);

    expect(
      console.log
    ).not.toHaveBeenCalled();
  });

});
```

---

### Part 19 — Test request logging

Now we'll test the HTTP middleware.

### File to create
```
tests/request-logging.middleware.test.ts
```
Use:

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
  requestLoggingMiddleware
} from "../src/middleware/request-logging.middleware.js";

import { logger } from "../src/logging/logger.js";

describe(
  "requestLoggingMiddleware",
  () => {

    beforeEach(() => {
      vi.spyOn(
        logger,
        "info"
      ).mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "should log completed HTTP requests",
      () => {

        const finishHandlers: (() => void)[] = [];

        const req = {
          method: "GET",
          originalUrl: "/health"
        };

        const res = {
          statusCode: 200,

          on: vi.fn(
            (
              event: string,
              callback: () => void
            ) => {

              if (
                event === "finish"
              ) {
                finishHandlers.push(
                  callback
                );
              }

              return res;
            }
          )
        };

        const next = vi.fn();

        requestLoggingMiddleware(
          req as any,
          res as any,
          next
        );

        expect(next)
          .toHaveBeenCalledTimes(1);

        expect(
          finishHandlers
        ).toHaveLength(1);

        finishHandlers[0]();

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "HTTP request completed",
          expect.objectContaining({
            method: "GET",
            path: "/health",
            statusCode: 200
          })
        );
      }
    );
  }
);
```

---

### Part 20 — Build the project

From the **project root:**

```
npm run build
```


Expected:

```
TypeScript compilation successful
```

If TypeScript reports errors, stop here and fix them.

---

### Part 21 — Run all tests

From the **project root:**

```
npm run test:run
```

We want the existing tests plus the new logging tests to pass.

You may have existing failures from the earlier lectures, particularly around the health test or the response contract.

Do not hide those failures.

Fix them based on the current architecture.

---


### Part 22 — Run the application

From the **project root:**

```
npm run dev

```

You should see a JSON log similar to:

```
{
  "timestamp": "2026-09-27T...",
  "level": "info",
  "service": "production-intelligence-platform",
  "message": "Server started",
  "metadata": {
    "port": 3000,
    "environment": "development"
  }
}

```
---

### Part 23 — Test /health

Call:
```
GET http://localhost:3000/health
```

You should now see a request log:

```
{
  "timestamp": "...",
  "level": "info",
  "service": "production-intelligence-platform",
  "message": "HTTP request completed",
  "metadata": {
    "method": "GET",
    "path": "/health",
    "statusCode": 200,
    "durationMs": 5
  }
}

```

The exact `durationMs` will differ.

That's expected.

---

### Part 24 — Test a 404

Call:

```
GET http://localhost:3000/does-not-exist

```

You should get:

```

{
  "success": false,
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "Route GET /does-not-exist not found"
  }
}

```

And your logs should contain an application warning:

```
{
  "level": "warn",
  "message": "Application error"
}

```

as well as the HTTP request completion log.

---

### Part 25 — Test incident creation

Call:
```
POST http://localhost:3000/incidents
```

with:
```
{
  "service": "payment-service",
  "severity": "critical"
}

```

You should receive the normal API response.

And the logs should include something like:

```
{
  "level": "info",
  "message": "Incident created",
  "metadata": {
    "incidentId": "...",
    "service": "payment-service",
    "severity": "critical",
    "status": "detected"
  }
}
```

This is our first meaningful ***business event log.***

---

### Part 26 — Intentionally break something

Now we do our required:
```
Build → Test → Break → Fix
```

Temporarily change:

### File
```
src/services/incident.service.ts
```

Change:

```
logger.info(
  "Incident created",
```

to:
```
logger.info(
  "INCIDENT_CREATED",
```

Run the test suite.

Our current tests may not explicitly verify this business message, so this is a good lesson:

#### A test suite only protects behavior that we actually assert.

We should add a test for this business behavior.

---

### Part 27 — What we have built

Our application now has:

```
HTTP Request
     │
     ▼
Request Logging Middleware
     │
     ▼
Controller
     │
     ▼
Service
     │
     ├── Business operation
     │
     └── Structured business log
     │
     ▼
Repository
     │
     ▼
PostgreSQL

```

Errors:

```
Error
  ↓
Error Middleware
  ↓
Structured Error Log
  ↓
JSON Error Response

```

---

### Part 28 — Final folder structure for Lecture 16

After this lecture, your relevant structure should be:

```
production-intelligence-platform/
│
├── src/
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
│   ├── services/
│   │   └── incident.service.ts
│   │
│   ├── types/
│   │   └── api-response.ts
│   │
│   ├── utils/
│   │   └── api-response.ts
│   │
│   ├── app.ts
│   ├── container.ts
│   └── server.ts
│
├── tests/
│   │
│   ├── logging/
│   │   ├── logger.test.ts
│   │   └── request-logging.middleware.test.ts
│   │
│   └── services/
│       └── incident.service.test.ts
│
├── .env
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---


### Lecture 16 — Final verification

Run these in this exact order from the project root.

### 1. PostgreSQL
```
docker compose up -d postgres

```
### 2. Migrations
```
npm run migrate
```

### 3. TypeScript
```
npm run build
```

### 4. Tests
```
npm run test:run
```
### 5. Start application
```
npm run dev
```
### 6. Test health
```
GET /health
```
### 7. Test 404
```
GET /does-not-exist
```
### 8. Test incident creation
```
POST /incidents
```

Body:
```
{
  "service": "payment-service",
  "severity": "critical"
}
```
### 9. Verify logs

You should see structured JSON logs containing:
```
timestamp
level
service
message
metadata
```
---




