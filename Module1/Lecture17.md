### Module 1 — Lecture 17

### Request IDs & Correlation IDs

We now have structured logging, but there is still a major problem.

Suppose one request produces:

```
HTTP request completed
Incident created
Database error
HTTP request failed
```

How do we know which logs belong to the same request?

We need a **request ID**.

Our target architecture:

```
HTTP Request
     │
     │ X-Request-ID: abc-123
     ▼
Request ID Middleware
     │
     ▼
Controller
     │
     ▼
Service
     │
     ▼
Repository
     │
     ▼
Logger
     │
     ▼
Every log contains abc-123
```

This is the beginning of **distributed tracing/correlation**.

We are not implementing OpenTelemetry yet. First, we need to understand the fundamental mechanism ourselves.

---

### Part 1 — What is a Request ID?

Imagine a client sends:

```
POST /incidents
```

Our server generates:

```
requestId = 7c9f...
```

Every log associated with that request should contain:

```
{
  "requestId": "7c9f..."
}
```

So instead of searching logs by timestamps, we can search:

```
requestId = 7c9f...
```

and see the entire request flow.

---

### Part 2 — Request ID vs Correlation ID

These terms are often used interchangeably, but there's a useful distinction.

#### Request ID

Identifies one HTTP request.

```
POST /incidents
requestId = abc
```

#### Correlation ID

Can represent a broader operation across multiple systems.

For example:

```
API request
    │
    ├── Service A
    │
    ├── Queue
    │
    ├── Worker
    │
    └── Service B
```

All of them might carry:

```
correlationId = abc
```

For today's lecture we'll establish:

```
requestId
```

as our request-scoped correlation identifier.

Later, when we introduce BullMQ, events, and distributed services, we'll extend this concept into proper correlation propagation.

---

### Part 3 — Current project structure

Before changing anything, our relevant structure is:

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
│   ├── logging/
│   │   ├── logger.test.ts
│   │   └── request-logging.middleware.test.ts
│   └── ...
│
├── package.json
├── tsconfig.json
└── docker-compose.yml
```

We will modify:

```
src/logging/request-context.ts
src/logging/logger.ts
src/middleware/request-context.middleware.ts
src/middleware/request-logging.middleware.ts
src/app.ts
```

And create:

```
tests/logging/request-context.test.ts
tests/logging/request-context.middleware.test.ts
```

---

### Part 4 — Why not simply put requestId on req?

We could do:

```
req.requestId
```

and then pass it manually:

```
service.doSomething(req.requestId)
```

Then:

```
Controller
   ↓
service(requestId)
   ↓
repository(requestId)
```

This becomes annoying very quickly.

Imagine:

```
Controller
   ↓
Service
   ↓
Service
   ↓
Repository
   ↓
Logger
```

We don't want every method to have:

```
requestId: string
```

just because logging needs it.

Instead we'll use Node.js's:

```
AsyncLocalStorage
```

This gives us request-scoped context.

---

### Part 5 — AsyncLocalStorage

Node.js provides:

```
AsyncLocalStorage
```

which allows us to associate data with an asynchronous execution context.

Conceptually:

```
Request A
requestId = AAA
   │
   ├── controller
   ├── service
   └── repository

Request B
requestId = BBB
   │
   ├── controller
   ├── service
   └── repository
```

Both requests can execute concurrently while maintaining separate contexts.

This is exactly what we need.

---

### Part 6 — Replace request-context.ts

File to modify

```
src/logging/request-context.ts
```

**Action**: Replace the entire file.

```
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const requestContextStorage =
  new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(
  context: RequestContext,
  callback: () => T
): T => {
  return requestContextStorage.run(
    context,
    callback
  );
};

export const getRequestContext =
  (): RequestContext | undefined => {
    return requestContextStorage.getStore();
  };

export const getRequestId =
  (): string | undefined => {
    return getRequestContext()?.requestId;
  };
```

---

### Part 7 — Understand this file

We now have three important functions.

#### runWithRequestContext

```
runWithRequestContext(
  { requestId: "abc" },
  () => {
    // request execution
  }
);
```

It creates the context.

#### getRequestContext

```
getRequestContext()
```

returns:

```
{
  requestId: "abc"
}
```

when called inside that request's asynchronous execution.

#### getRequestId

Convenience function:

```
getRequestId()
```

returns:

```
abc
```

---

### Part 8 — Create Request Context Middleware

Now we need middleware that creates the context.

File to create

```
src/middleware/request-context.middleware.ts
```

Use:

```
import {
  randomUUID
} from "node:crypto";

import {
  Request,
  Response,
  NextFunction
} from "express";

import {
  runWithRequestContext
} from "../logging/request-context.js";

const REQUEST_ID_HEADER =
  "x-request-id";

const MAX_REQUEST_ID_LENGTH = 128;

const isValidRequestId = (
  value: string
): boolean => {
  return (
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH
  );
};

export const requestContextMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const incomingRequestId =
    req.header(REQUEST_ID_HEADER);

  const requestId =
    incomingRequestId &&
    isValidRequestId(incomingRequestId)
      ? incomingRequestId
      : randomUUID();

  res.setHeader(
    "X-Request-ID",
    requestId
  );

  runWithRequestContext(
    { requestId },
    () => {
      next();
    }
  );
};
```

---

### Part 9 — Why accept an incoming request ID?

Suppose another service calls our API:

```
Service A
   │
   │ X-Request-ID: abc
   ▼
Our API
```

We want to preserve:

```
abc
```

instead of generating:

```
xyz
```

Otherwise the trace gets broken.

But if there is no incoming ID:

```
Client
   │
   │ no X-Request-ID
   ▼
Our API
```

we generate one:

```
randomUUID()
```

---

### Part 10 — Why limit the request ID?

We don't want someone sending:

```
X-Request-ID: <10 MB string>
```

and causing unnecessary memory/logging problems.

So:

```
MAX_REQUEST_ID_LENGTH = 128
```

is a simple defensive boundary.

If the incoming value is too large, we generate a new UUID.

---

### Part 11 — Update application middleware order

This step is extremely important.

The request context must exist **before any middleware or route that wants to log it**.

#### File to modify

```
src/app.ts
```

Action: Replace the entire file.

```
import express from "express";

import healthRoutes from "./routes/health.routes.js";
import incidentRoutes from "./routes/incident.routes.js";

import {
  notFoundMiddleware
} from "./middleware/not-found.middleware.js";

import {
  errorMiddleware
} from "./middleware/error.middleware.js";

import {
  requestContextMiddleware
} from "./middleware/request-context.middleware.js";

import {
  requestLoggingMiddleware
} from "./middleware/request-logging.middleware.js";

const app = express();

app.use(express.json());

app.use(requestContextMiddleware);

app.use(requestLoggingMiddleware);

app.use("/health", healthRoutes);

app.use("/incidents", incidentRoutes);

app.use(notFoundMiddleware);

app.use(errorMiddleware);

export default app;
```

The order is now:

```
express.json()
      ↓
requestContextMiddleware
      ↓
requestLoggingMiddleware
      ↓
routes
      ↓
404
      ↓
error handler
```

This ordering is intentional.

---

### Part 12 — Update the logger

Our current logger accepts **metadata**, but it doesn't automatically include the request ID.

We will fix that.

#### File to modify

```
src/logging/logger.ts
```

**Action**: Replace the entire file.

```
import type { LogLevel } from "./log-level.js";
import {
  getRequestId
} from "./request-context.js";

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

  const requestId =
    getRequestId();

  const combinedMetadata: LogMetadata = {
    ...(requestId
      ? { requestId }
      : {}),
    ...(metadata ?? {})
  };

  const entry: LogEntry = {
    timestamp:
      new Date().toISOString(),

    level,

    service:
      APPLICATION_NAME,

    message,

    ...(Object.keys(
      combinedMetadata
    ).length > 0
      ? {
          metadata:
            combinedMetadata
        }
      : {})
  };

  const serialized =
    JSON.stringify(entry);

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

### Part 13 — What changed?

Previously:

```
logger.info(
  "Incident created",
  {
    incidentId: "123"
  }
);
```

produced:

```
{
  "level": "info",
  "message": "Incident created",
  "metadata": {
    "incidentId": "123"
  }
}
```

Now, if we're inside a request:

```

{
  "level": "info",
  "message": "Incident created",
  "metadata": {
    "requestId": "abc-123",
    "incidentId": "123"
  }
}
```

The service doesn't need:

```
requestId
```

passed through every method.

That's the important part.

---

### Part 14 — Update request logging middleware

Our existing request logger doesn't explicitly include the request ID.

The logger now automatically adds it, but we should also explicitly understand the middleware.

#### File to modify

```
src/middleware/request-logging.middleware.ts
```

**Action**: Replace the entire file.

```
import {
  Request,
  Response,
  NextFunction
} from "express";

import {
  logger
} from "../logging/logger.js";

import {
  getRequestId
} from "../logging/request-context.js";

export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const startedAt =
    Date.now();

  const requestId =
    getRequestId();

  res.on(
    "finish",
    () => {

      const durationMs =
        Date.now() - startedAt;

      logger.info(
        "HTTP request completed",
        {
          requestId,
          method: req.method,
          path: req.originalUrl,
          statusCode:
            res.statusCode,
          durationMs
        }
      );
    }
  );

  next();
};
```

Notice something subtle:

We explicitly provide:

```
requestId
```

but the logger also automatically adds it.

Because the explicit metadata comes after the automatic context:

```
const combinedMetadata = {
  ...(requestId ? { requestId } : {}),
  ...(metadata ?? {})
};
```

the explicit value wins.

That's okay, but we don't actually need to provide it here because the logger already knows it.

We can simplify the middleware.

---

### Part 15 — Final request logging middleware

To avoid duplication, replace the file one more time with the cleaner version.

#### File

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

import {
  logger
} from "../logging/logger.js";

export const requestLoggingMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  const startedAt =
    Date.now();

  res.on(
    "finish",
    () => {

      const durationMs =
        Date.now() - startedAt;

      logger.info(
        "HTTP request completed",
        {
          method: req.method,
          path: req.originalUrl,
          statusCode:
            res.statusCode,
          durationMs
        }
      );
    }
  );

  next();
};
```

Now:

```
Request context
       ↓
Logger automatically retrieves requestId
       ↓
Every log gets requestId
```

That's cleaner.

---

### Part 16 — Error logs now automatically get request ID

We don't need to change the error middleware just to add:

```
requestId
```

because the logger gets it automatically.

For example:

```
logger.error(
  "Unhandled application error",
  {
    method: req.method,
    path: req.originalUrl
  }
);
```

becomes:

```
{
  "level": "error",
  "message": "Unhandled application error",
  "metadata": {
    "requestId": "abc-123",
    "method": "GET",
    "path": "/incidents/..."
  }
}
```

This is exactly what we wanted.

---

### Part 17 — Test AsyncLocalStorage directly

We need to prove that the context actually propagates.

#### Folder

```
tests/
```

Already exists from Lecture 16.

#### File to create

```
tests/request-context.test.ts
```

Use:

```
import {
  describe,
  expect,
  it
} from "vitest";

import {
  getRequestId,
  runWithRequestContext
} from "../src/logging/request-context.js";

describe(
  "request context",
  () => {

    it(
      "should expose the request ID inside the context",
      () => {

        let requestId:
          string | undefined;

        runWithRequestContext(
          {
            requestId:
              "request-123"
          },
          () => {

            requestId =
              getRequestId();
          }
        );

        expect(requestId)
          .toBe("request-123");
      }
    );

    it(
      "should return undefined outside a request context",
      () => {

        expect(
          getRequestId()
        ).toBeUndefined();
      }
    );
  }
);
```

---

### Part 18 — Test asynchronous propagation

This test is particularly important.

#### File to modify

```
tests/request-context.test.ts
```

Add this test inside the existing **describe**:

```
it(
  "should preserve the request ID across async operations",
  async () => {

    let requestId:
      string | undefined;

    await runWithRequestContext(
      {
        requestId:
          "request-async-123"
      },
      async () => {

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              10
            )
        );

        requestId =
          getRequestId();
      }
    );

    expect(requestId)
      .toBe(
        "request-async-123"
      );
  }
);
```

This proves the context survives an asynchronous boundary.

That is one of the reasons we are using **AsyncLocalStorage**.

---

### Part 19 — Test request context middleware

#### File to create

tests/request-context.middleware.test.ts

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
  requestContextMiddleware
} from "../../src/middleware/request-context.middleware.js";

import {
  getRequestId
} from "../../src/logging/request-context.js";

describe(
  "requestContextMiddleware",
  () => {

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "should preserve a valid incoming request ID",
      () => {

        const req = {
          header: vi.fn()
            .mockReturnValue(
              "client-request-123"
            )
        };

        const headers:
          Record<string, string> = {};

        const res = {
          setHeader: vi.fn(
            (
              name: string,
              value: string
            ) => {
              headers[name] = value;
            }
          )
        };

        const next = vi.fn();

        requestContextMiddleware(
          req as any,
          res as any,
          next
        );

        expect(
          next
        ).toHaveBeenCalledTimes(1);

        expect(
          headers["X-Request-ID"]
        ).toBe(
          "client-request-123"
        );
      }
    );

    it(
      "should generate a request ID when none is provided",
      () => {

        const req = {
          header: vi.fn()
            .mockReturnValue(
              undefined
            )
        };

        const headers:
          Record<string, string> = {};

        const res = {
          setHeader: vi.fn(
            (
              name: string,
              value: string
            ) => {
              headers[name] = value;
            }
          )
        };

        const next = vi.fn();

        requestContextMiddleware(
          req as any,
          res as any,
          next
        );

        expect(
          next
        ).toHaveBeenCalledTimes(1);

        expect(
          headers["X-Request-ID"]
        ).toBeDefined();

        expect(
          headers["X-Request-ID"].length
        ).toBeGreaterThan(0);
      }
    );
  }
);
```

---

### Part 20 — Test logger correlation

Now we'll prove that the logger automatically receives the request ID.

### File to modify

```
tests/logging/logger.test.ts
```

Add this import:

```
import {
  runWithRequestContext
} from "../src/logging/request-context.js";
```

Then add this test:

```
it(
  "should automatically include request ID",
  () => {

    runWithRequestContext(
      {
        requestId:
          "request-456"
      },
      () => {

        logger.info(
          "Request scoped log"
        );
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

    expect(
      entry.metadata.requestId
    ).toBe(
      "request-456"
    );
  }
);
```

---

### Part 21 — Important test isolation issue

Our **logger.test.ts** already has:

```
beforeEach()
```

and:

```
afterEach()
```

which restore mocks.

That's good.

But remember:

```
AsyncLocalStorage
```

contexts are scoped.

We should not rely on one test leaving context for another.

Each test creates its own:

```
runWithRequestContext(...)
```

This keeps tests deterministic.

---

### Part 22 — Test the complete API

Now we want a real integration test.

This is more important than the unit tests because it proves:

```
HTTP
 ↓
Middleware
 ↓
Request context
 ↓
Logger
```

all work together.

#### File to modify

```
tests/incidents.api.test.ts
```

We need to capture logs.

Add:

```
import {
  vi,
  beforeEach,
  afterEach
} from "vitest";
```

Then inside the **describe**:

```
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
```

---

### Part 23 — Add request ID API test

Still in:

```
tests/incidents.api.test.ts
```

Add:

```
it(
  "should return the request ID in the response header",
  async () => {

    const response =
      await request(app)
        .get("/health");

    expect(
      response.headers[
        "x-request-id"
      ]
    ).toBeDefined();

    expect(
      response.headers[
        "x-request-id"
      ].length
    ).toBeGreaterThan(0);
  }
);
```

---

### Part 24 — Test incoming request ID

Add another test:

```
it(
  "should preserve an incoming request ID",
  async () => {

    const requestId =
      "test-request-789";

    const response =
      await request(app)
        .get("/health")
        .set(
          "X-Request-ID",
          requestId
        );

    expect(
      response.headers[
        "x-request-id"
      ]
    ).toBe(requestId);
  }
);
```

This verifies:

```
Client
  │
  │ X-Request-ID: test-request-789
  ▼
API
  │
  ▼
Response
  │
  └── X-Request-ID: test-request-789
```

---

### Part 25 — Verify logs contain the same ID

Add:

```
it(
  "should include the request ID in request logs",
  async () => {

    const requestId =
      "test-request-log-123";

    await request(app)
      .get("/health")
      .set(
        "X-Request-ID",
        requestId
      );

    const calls =
      vi.mocked(console.log)
        .mock.calls;

    const matchingLog =
      calls.find(
        ([message]) => {

          try {
            const entry =
              JSON.parse(
                String(message)
              );

            return (
              entry.message ===
                "HTTP request completed" &&
              entry.metadata?.requestId ===
                requestId
            );

          } catch {
            return false;
          }
        }
      );

    expect(
      matchingLog
    ).toBeDefined();
  }
);
```
Now we are testing the actual correlation behavior.

---

### Part 26 — Run TypeScript

From:
```
production-intelligence-platform/
```
run:
```
npm run build
```
Do not continue if TypeScript fails.

---

### Part 27 — Run all tests

Run:
```
npm run test:run
```
We want:

```
logger tests
        ↓
PASS

request-context tests
        ↓
PASS

request-context middleware tests
        ↓
PASS

request logging tests
        ↓
PASS

API tests
        ↓
PASS
```

---

### Part 28 — Start the application

Run:
```
npm run dev
```
Then call:
```
GET /health
```
Look at the response headers.

You should see:
```
X-Request-ID: <some UUID>
```

### Part 29 — Send your own request ID

Use:
```
GET /health
X-Request-ID: my-debug-request-123
```
The response should contain:
```
X-Request-ID: my-debug-request-123
```
And the logs should contain:

```
{
  "level": "info",
  "message": "HTTP request completed",
  "metadata": {
    "requestId": "my-debug-request-123",
    "method": "GET",
    "path": "/health",
    "statusCode": 200,
    "durationMs": 5
  }
}
```
The exact duration will differ.

---

### Part 30 — Test an error

Call:
```
GET /incidents/00000000-0000-0000-0000-000000000000
X-Request-ID: error-test-123
```
The response should be:
```
{
  "success": false,
  "error": {
    "code": "INCIDENT_NOT_FOUND",
    "message": "Incident not found"
  }
}
```
And the error log should contain:
```
requestId = error-test-123
```
This is the important result.

We can now search our logs for:
```
error-test-123
```
and identify all logs belonging to that request.

---

### Part 31 — Intentional failure test

Now let's prove that correlation is actually working.

#### File to modify
```
src/request-context.ts
```
Temporarily change:
```
return requestContextStorage.getStore();
```
to:
```
return undefined;
```
Now run:
```
npm run test:run
```
Our request-context tests should fail.

The logger correlation test should also fail.

This is good.

We've intentionally broken the feature.

Restore:
```
return requestContextStorage.getStore();
```
Then run:
```
npm run test:run
```
again.

Everything should pass.

This is the **build → test → break → fix** workflow we're following throughout this project.

---

### Part 32 — Why this matters later

Right now our architecture is:
```
HTTP Request
     │
     ▼
Request ID
     │
     ▼
Express
     │
     ▼
Service
     │
     ▼
PostgreSQL
```
Later it will become:

```
HTTP Request
     │
     │ correlationId
     ▼
API
     │
     ▼
PostgreSQL
     │
     ▼
BullMQ
     │
     │ correlationId
     ▼
Worker
     │
     ▼
Incident Engine
     │
     ▼
Event Bus
     │
     │ correlationId
     ▼
Another Service

```
Without correlation IDs, debugging this becomes extremely difficult.

With them:
```
correlationId = abc123
```
we can trace the entire operation.

---

### Part 33 — Request ID is not authentication

Important distinction:
```
X-Request-ID
```
does **not** prove who the user is.

It is only an identifier.

Do not use it as:
```
authentication
authorization
session token
security credential
```
Its purpose is observability/correlation.

---

### Part 34 — Current logging architecture

We now have:

```
                  ┌───────────────────────┐
                  │ Request               │
                  └──────────┬────────────┘
                             │
                             ▼
                  ┌───────────────────────┐
                  │ Request Context       │
                  │ AsyncLocalStorage     │
                  │                       │
                  │ requestId = ABC       │
                  └──────────┬────────────┘
                             │
                 ┌───────────┴───────────┐
                 │                       │
                 ▼                       ▼
           Controller                 Logger
                 │                       │
                 ▼                       │
             Service                     │
                 │                       │
                 ▼                       │
           Repository                    │
                 │                       │
                 └───────────┬───────────┘
                             ▼
                       Structured JSON
```
The logger automatically reads the request context.

---

### Part 35 — Final folder structure

After Lecture 17, the relevant project structure should be:

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
│   │   ├── request-context.middleware.ts
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
│   │   ├── request-context.test.ts
│   │   ├── request-context.middleware.test.ts
│   │   └── request-logging.middleware.test.ts
│   │
│   ├── services/
│   │   └── incident.service.test.ts
│   │
│   └── ...
│
├── .env
├── .gitignore
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---

### Lecture 17 — Final verification

Run these from the project root.

#### 1. PostgreSQL
```
docker compose up -d postgres
```
#### 2. Migrations
```
npm run migrate
```
#### 3. Build
```
npm run build
```
#### 4. Tests
```
npm run test:run
```
#### 5. Start server
```
npm run dev
```
#### 6. Test without request ID
```
GET /health
```
Verify:
```
X-Request-ID
```
exists.

#### 7. Test with request ID
```
GET /health
X-Request-ID: test-123
```
Verify the response header is:
```
X-Request-ID: test-123
```
#### 8. Test incident
```
POST /incidents
X-Request-ID: incident-test-123
```
Body:
```
{
  "service": "payment-service",
  "severity": "critical"
}
```
Verify the **Incident created** log contains:
```
requestId = incident-test-123
```
#### 9. Test error
```
GET /incidents/00000000-0000-0000-0000-000000000000
X-Request-ID: error-test-123
```
Verify the error log contains:
```
requestId = error-test-123
```

---
