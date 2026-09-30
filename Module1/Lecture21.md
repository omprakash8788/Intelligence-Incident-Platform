# Module 1 — Lecture 21: Rate Limiting

> **Project:** Production Intelligence & Incident Platform  
> **Stack:** Node.js + TypeScript + Express + PostgreSQL  
> **Architecture principle:** A public API must control how much work one client can force the application to perform.

---

# 1. Lecture Objective

Our application now has:

- HTTP security headers
- request body limits
- input validation
- parameterized SQL
- safe error responses
- request IDs
- structured logging
- graceful shutdown
- liveness checks
- readiness checks

But there is still an important problem.

Imagine a client sends:

```text
100 requests
1,000 requests
10,000 requests
100,000 requests
```

in a short period.

Every request consumes some combination of:
```
CPU
Memory
Network
Database connections
Database queries
Application execution time
Logs
```
Without rate limiting:

```
Client
  │
  │ 10,000 requests
  ▼
Express
  │
  ▼
Controllers
  │
  ▼
Services
  │
  ▼
PostgreSQL
```
The application can become overloaded.

We need:
```
Client
  │
  │ many requests
  ▼
Rate Limiter
  │
  ├── allowed ──────► Application
  │
  └── rejected ─────► 429
```

---

### 2. What Is Rate Limiting?

Rate limiting controls how many requests a client can make during a defined period.

For example:
```
100 requests
per 15 minutes
```
If a client sends:
```
Request 1  → allowed
Request 2  → allowed
...
Request 100 → allowed
Request 101 → rejected
```
The rejected request receives:
```
429 Too Many Requests
```

---

### 3. Why HTTP 429?

HTTP status:
```
429 Too Many Requests
```
means the client has exceeded the allowed request rate.

Example:
```
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests"
  }
}
```
The client should understand:
```
The server is reachable.

The request format may be valid.

But the client is sending requests too quickly.
```

---

### 4. Rate Limiting Is Not Authentication

These are different problems.

#### Authentication
```
Who are you?
```
#### Authorization
```
What are you allowed to do?
```
#### Rate limiting
```
How much traffic can you send?
```
A request can be:
```
Authenticated
Authorized
But rate-limited
```
For example:
```
User A
  │
  ├── authenticated
  ├── authorized
  └── 1,000 requests/minute
           ↓
        429
```

---

### 5. Why We Are Learning Rate Limiting Before Authentication

Rate limiting is an infrastructure-level protection.

It does not require us to know the user's identity.

Initially we can identify clients by:
```
IP address
```
Later, after authentication, we can also use:
```
user ID
API key
organization ID
tenant ID
```
This leads to more advanced rate-limiting strategies.

---

### 6. Rate Limiting Algorithms

There are several common algorithms:
```
Fixed Window
Sliding Window
Token Bucket
Leaky Bucket
```
We will understand the concepts before implementing production middleware.

---

### 7. Fixed Window

Suppose:
```
Limit = 100 requests
Window = 1 minute
```
The clock creates windows:
```
12:00:00 ───────── 12:00:59
12:01:00 ───────── 12:01:59
12:02:00 ───────── 12:02:59
```
Client can make:
```
100 requests
```
inside each window.

---

### 8. Fixed Window Problem

Consider:
```
12:00:59
```
A client sends:
```
100 requests
```
Then at:
```
12:01:00
```
the client sends another:
```
100 requests
```
The client has effectively sent:
```
200 requests
```
within approximately:
```
2 seconds
```
This is called a boundary problem.
Fixed windows are simple, but they are not perfect.

---

### 9. Sliding Window

A sliding window considers a moving time range.

Example:
```
Last 60 seconds
```
instead of fixed clock boundaries.

This gives smoother behavior.

But it requires more state and can be more expensive to implement.

---

### 10. Token Bucket

Another common approach is:
```
Bucket
  │
  ├── tokens
  ├── refill rate
  └── maximum capacity
```
Each request consumes one token.

For example:
```
Bucket capacity = 100
Refill = 10 tokens/second
```
Requests consume tokens:
```
Request
   ↓
Token available?
   │
   ├── yes → consume token → allow
   │
   └── no  → reject
```
Token buckets are useful when you want to allow controlled bursts.

---

### 11. What We Will Implement

For this lecture we will use:
```
express-rate-limit
```
with an in-memory store.

This gives us a production-oriented middleware interface without pretending that an in-memory limiter is suitable for a multi-instance distributed deployment.

Our progression will be:
```
Lecture 21
    │
    ▼
In-memory rate limiting
    │
    ▼
Understand limitations
    │
    ▼
Later Redis
    │
    ▼
Distributed rate limiting
```

---

### 12. Important Production Limitation

An in-memory limiter stores state inside one Node.js process.

Imagine:
```
             Load Balancer
             /           \
            ▼             ▼
        Instance A     Instance B
            │             │
       Counter A      Counter B
```
If a client sends:
```
50 requests → A
50 requests → B
```
each instance sees only:
```
50
```
instead of:
```
100
```
Therefore:

*In-memory rate limiting is not a distributed rate limiter.*
It is useful for:

- local development
- single-instance deployments
- basic protection
- learning the architecture

Later we will use Redis for shared rate-limit state.

---

### 13. Install the Package

From the project root:
```
npm install express-rate-limit
```
Verify:
```
npm ls express-rate-limit
```

---

### 14. Create Rate Limit Configuration

Create:
```
src/config/rate-limit.ts
```
Complete file:
```
import {
  rateLimit
} from "express-rate-limit";

export const apiRateLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    limit: 100,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    message: {
      success: false,
      error: {
        code:
          "RATE_LIMIT_EXCEEDED",
        message:
          "Too many requests"
      }
    }
  });
```
---

### 15. Understand the Configuration

We have:
```
windowMs:
  15 * 60 * 1000
```
which means:
```
15 minutes
```
The limit is:
```
limit: 100
```
Therefore the current policy is:
```
100 requests
per 15 minutes
```

---

### 16. Why 100 Requests?

This number is intentionally a starting point.

It is not a universal production value.

A real production limit should depend on:
```
Endpoint
Expected traffic
Client behavior
Business requirements
Database capacity
Latency
Deployment size
Authentication model
Tenant requirements
```
For example:
```
GET /health/live
```
may need a different policy from:
```
POST /incidents
```
and an authentication endpoint may need a much stricter policy.

We will eventually create route-specific policies.

---

### 17. Why standardHeaders?

Modern rate-limit middleware can communicate rate-limit information through standard response headers.

The exact headers depend on the configured standard-header format and package version.

The purpose is to allow clients and infrastructure to understand:
```
How many requests remain?
When does the limit reset?
What limit applies?
```
We will verify the headers in tests instead of assuming their exact formatting.

---

### 18. Why Disable Legacy Headers?

We use:
```
legacyHeaders: false
```
because we do not want to emit older *X-RateLimit-** style headers alongside the configured standard headers.

This keeps our API behavior explicit and avoids duplicate rate-limit metadata.

---

### 19. Create a Reusable Rate Limiter Factory

Before registering the global limiter, we should make the configuration testable.

Replace:
```
src/config/rate-limit.ts
```
with:
```
import {
  rateLimit
} from "express-rate-limit";

interface RateLimitOptions {
  windowMs: number;
  limit: number;
}

export const createRateLimiter = (
  options: RateLimitOptions
) => {

  return rateLimit({
    windowMs:
      options.windowMs,

    limit:
      options.limit,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    message: {
      success: false,
      error: {
        code:
          "RATE_LIMIT_EXCEEDED",
        message:
          "Too many requests"
      }
    }
  });
};

export const apiRateLimiter =
  createRateLimiter({
    windowMs:
      15 * 60 * 1000,

    limit: 100
  });
```
---

### 20. Why Create a Factory?

Testing a limiter with:
```
100 requests
```
would make tests unnecessarily large.

Instead, tests can create:
```
limit = 2
```
with:
```
window = 1 minute
```
Then:
```
Request 1 → 200
Request 2 → 200
Request 3 → 429
```
This is much easier to test.

---

### 21. Where Should Rate Limiting Be Registered?

We want the limiter to run before expensive application work.

Our pipeline becomes:
```
Security Headers
       ↓
JSON Body Parser
       ↓
Request ID
       ↓
Rate Limiter
       ↓
Request Logging
       ↓
Routes
```
This means requests exceeding the limit should not reach:
```
Controller
Service
Repository
PostgreSQL
```

---

### 22. Update app.ts
#### File
```
src/app.ts
```
Replace the complete file with:
```
import express from "express";

import healthRoutes
  from "./routes/health.routes.js";

import incidentRoutes
  from "./routes/incident.routes.js";

import {
  notFoundMiddleware
} from "./middleware/not-found.middleware.js";

import {
  errorMiddleware
} from "./middleware/error.middleware.js";

import {
  requestIdMiddleware
} from "./middleware/request-id.middleware.js";

import {
  requestLoggingMiddleware
} from "./middleware/request-logging.middleware.js";

import {
  securityMiddleware
} from "./middleware/security.middleware.js";

import {
  apiRateLimiter
} from "./config/rate-limit.js";

const app = express();

app.use(
  securityMiddleware
);

app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(
  requestIdMiddleware
);

app.use(
  apiRateLimiter
);

app.use(
  requestLoggingMiddleware
);

app.use(
  "/health",
  healthRoutes
);

app.use(
  "/incidents",
  incidentRoutes
);

app.use(
  notFoundMiddleware
);

app.use(
  errorMiddleware
);

export default app;
```
---

### 23. Important Ordering Decision

We placed:
```
apiRateLimiter
```
before:
```
requestLoggingMiddleware
```
and before routes.

The request flow is now:
```
Request
   ↓
Security
   ↓
Body parser
   ↓
Request ID
   ↓
Rate limiter
   ↓
Request logging
   ↓
Routes
```
This has an important consequence.

A rate-limited request may be rejected before the request-completion logger is registered.

We need to think about whether that is desirable.

---

### 24. Observability vs Rate Limiting

We want to know about rejected requests.

Therefore, an alternative ordering is:
```
Request ID
   ↓
Request logging
   ↓
Rate limiter
   ↓
Routes
```
Then even rate-limited requests can be observed.

This is more useful for our platform.

We should therefore change the order.

---

### 25. Final Middleware Order
#### File
```
src/app.ts
```
Use:
```
import express from "express";

import healthRoutes
  from "./routes/health.routes.js";

import incidentRoutes
  from "./routes/incident.routes.js";

import {
  notFoundMiddleware
} from "./middleware/not-found.middleware.js";

import {
  errorMiddleware
} from "./middleware/error.middleware.js";

import {
  requestIdMiddleware
} from "./middleware/request-id.middleware.js";

import {
  requestLoggingMiddleware
} from "./middleware/request-logging.middleware.js";

import {
  securityMiddleware
} from "./middleware/security.middleware.js";

import {
  apiRateLimiter
} from "./config/rate-limit.js";

const app = express();

app.use(
  securityMiddleware
);

app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(
  requestIdMiddleware
);

app.use(
  requestLoggingMiddleware
);

app.use(
  apiRateLimiter
);

app.use(
  "/health",
  healthRoutes
);

app.use(
  "/incidents",
  incidentRoutes
);

app.use(
  notFoundMiddleware
);

app.use(
  errorMiddleware
);

export default app;
```

Now:
```
Request
   ↓
Security
   ↓
Body limit
   ↓
Request ID
   ↓
Request logging
   ↓
Rate limiting
   ↓
Routes
```
This allows rate-limit rejections to still be observable.

### 26. Important Observation About Body Parsing

Notice that:
```
express.json()
```
comes before the rate limiter.

That means a large request body can be processed before the rate limiter rejects the request.

This is not necessarily ideal.

There are two different protections:
```
Body limit
```
protects against:
```
large payloads
```
while:
```
rate limiting
```
protects against:
```
too many requests
```
We need both.

For very large or expensive requests, more advanced architectures can perform edge-level rate limiting before the application even receives the request.

That is outside our current application layer.

---

### 27. Rate Limiting Key

By default, the middleware identifies clients using the request IP.

Conceptually:
```
IP address
    ↓
rate-limit key
    ↓
request counter
```
For example:
```
192.168.1.10
```
might have:
```
47 requests
```
while:
```
192.168.1.11
```
has:
```
12 requests
```
Each gets its own counter.

---

### 28. Why IP Is Not a Perfect Identity

Many users can share one public IP.

For example:
```
Office
  │
  ├── User A
  ├── User B
  ├── User C
  └── User D
       │
       ▼
  Same public IP
```
An IP-based limiter may therefore rate-limit the group rather than an individual user.

Later, after authentication:
```
User ID
```
can become a more meaningful rate-limit identity.

---

### 29. Reverse Proxies and Client IPs

In production, our application may sit behind:
```
Internet
   ↓
Load Balancer
   ↓
Reverse Proxy
   ↓
Node.js
```
Then the Node process may see the proxy IP instead of the original client IP unless Express is configured appropriately.

We must never blindly trust:
```
X-Forwarded-For
```
from arbitrary clients.

The correct *trust proxy* configuration depends on our actual network topology.

We will configure this when we containerize/deploy the application.

For now, local development uses the direct connection.

---

### 30. Create Rate Limit Tests

Create:
```
tests/security/rate-limit.test.ts
```
Complete file:
```
import {
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import express from "express";

import {
  createRateLimiter
} from "../../src/config/rate-limit.js";

describe(
  "rate limiting",
  () => {

    const createTestApp =
      () => {

        const app =
          express();

        app.use(
          express.json()
        );

        app.use(
          createRateLimiter({
            windowMs:
              60 * 1000,

            limit: 2
          })
        );

        app.get(
          "/test",
          (_req, res) => {
            res.status(200).json({
              success: true
            });
          }
        );

        return app;
      };

    it(
      "should allow requests within the limit",
      async () => {

        const app =
          createTestApp();

        const first =
          await request(app)
            .get("/test");

        const second =
          await request(app)
            .get("/test");

        expect(first.status)
          .toBe(200);

        expect(second.status)
          .toBe(200);
      }
    );

    it(
      "should reject requests after the limit",
      async () => {

        const app =
          createTestApp();

        await request(app)
          .get("/test");

        await request(app)
          .get("/test");

        const third =
          await request(app)
            .get("/test");

        expect(third.status)
          .toBe(429);

        expect(third.body)
          .toEqual({
            success: false,
            error: {
              code:
                "RATE_LIMIT_EXCEEDED",
              message:
                "Too many requests"
            }
          });
      }
    );
  }
);
```
---

### 31. Run Tests

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

### 32. Test That the Real Application Has Rate Limiting

Create:
```
tests/security/rate-limit.api.test.ts
```
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
  "API rate limiting",
  () => {

    it(
      "should expose rate limit headers",
      async () => {

        const response =
          await request(app)
            .get("/health/live");

        expect(
          response.headers[
            "ratelimit"
          ]
        ).toBeDefined();
      }
    );
  }
);
```
---

### 33. Why We Don't Test 101 Requests

Our production limiter is:
```
100 requests / 15 minutes
```
We do not want our test suite to perform:
```
101 HTTP requests
```
for every test run.

Instead, we tested the behavior with a dedicated limiter:
```
2 requests / minute
```
This is faster and deterministic.

The real application test only verifies that the limiter is actually registered.

---

### 34. Run the Tests

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

### 35. Test Rate Limiting Manually

Start:
```
npm run dev
```
Now send requests:
```
curl -i http://localhost:3000/health/live
```
Look at the response headers.

You should see rate-limit information generated by the configured middleware.

The exact header representation depends on the configured standard-header mode.

---

### 36. Manual Stress Test

We can generate repeated requests from PowerShell.

For example:
```
1..105 | ForEach-Object {
    $response = Invoke-WebRequest `
        -Uri "http://localhost:3000/health/live" `
        -UseBasicParsing `
        -SkipHttpErrorCheck

    "$($_): $($response.StatusCode)"
}
```
The first requests should succeed.

After the configured limit is reached, responses should become:
```
429
```
Because the application limiter is:
```
100 / 15 minutes
```
you should expect the transition around the configured limit for a given client identity.

---


### 37. Important Testing Problem

The in-memory limiter survives for the lifetime of the Node process.

If you manually test:
```
100 requests
```
and then immediately run another test, you may still be rate-limited.

Restart the development server if necessary:
```
Ctrl + C
```
then:
```
npm run dev
```
This resets the in-memory limiter.

This is another reason distributed/shared rate limiting requires external state.

---

### 38. Intentional Break #1

Now deliberately remove the limiter from the application.

#### File
```
src/app.ts
```
Temporarily remove:
```
app.use(
  apiRateLimiter
);
```
Run:
```
npm run test:run
```
The real API rate-limit registration test should fail because the response no longer contains rate-limit headers.

Restore:
```
app.use(
  apiRateLimiter
);
```
Run:
```
npm run test:run
```
The tests should pass again.

---

### 39. Intentional Break #2

Now break the limit.

#### File
```
src/config/rate-limit.ts
```
Temporarily change:
```
limit: 2
```
inside the test factory defaults only if you want to break the dedicated test, or alternatively change the test's configured limit from:
```
limit: 2
```
to:
```
limit: 3
```
while still making three requests.

Run:
```
npm run test:run
```
The rate-limit rejection test should fail.

Restore:
```
limit: 2
```
Run:
```
npm run test:run
```
It should pass.

---

### 40. Rate Limiting and Health Checks

There is an important design question:

Should:
```
/health/live
/health/ready
```
be rate limited?

Our current application applies the limiter globally.

That means health checks count toward the application's rate limit.

This is not always desirable.

Infrastructure may call:
```
/health/live
```
frequently.

For example:
```
Load Balancer
    │
    ├── health check
    ├── health check
    ├── health check
    └── health check
```
We don't want infrastructure traffic to consume the same quota as user traffic.

Therefore, we should exempt health endpoints from the general API limiter.

---

### 41. Better Architecture

Instead of:
```
Request
   ↓
Global Rate Limiter
   ↓
Health
   ↓
Incidents
```
we can use:
```
Request
   ↓
Security
   ↓
Request ID
   ↓
Request Logging
   ↓
       ┌───────────────┐
       │               │
       ▼               ▼
    Health          API Limiter
                       │
                       ▼
                   Incidents
```
This is a better separation.

---

### 42. Update app.ts
#### File
```
src/app.ts
```
Use:
```
import express from "express";

import healthRoutes
  from "./routes/health.routes.js";

import incidentRoutes
  from "./routes/incident.routes.js";

import {
  notFoundMiddleware
} from "./middleware/not-found.middleware.js";

import {
  errorMiddleware
} from "./middleware/error.middleware.js";

import {
  requestIdMiddleware
} from "./middleware/request-id.middleware.js";

import {
  requestLoggingMiddleware
} from "./middleware/request-logging.middleware.js";

import {
  securityMiddleware
} from "./middleware/security.middleware.js";

import {
  apiRateLimiter
} from "./config/rate-limit.js";

const app = express();

app.use(
  securityMiddleware
);

app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(
  requestIdMiddleware
);

app.use(
  requestLoggingMiddleware
);

app.use(
  "/health",
  healthRoutes
);

app.use(
  "/incidents",
  apiRateLimiter,
  incidentRoutes
);

app.use(
  notFoundMiddleware
);

app.use(
  errorMiddleware
);

export default app;
```

---

### 43. Why Route-Level Rate Limiting?

Now:
```
/health/*
```
does not use:
```
apiRateLimiter
```
while:
```
/incidents/*
```
does.

This gives us better control.

The architecture becomes:
```
Express
                       │
             ┌─────────┴─────────┐
             │                   │
             ▼                   ▼
          /health            /incidents
             │                   │
             │             Rate Limiter
             │                   │
             ▼                   ▼
        Health APIs         Incident APIs
```

---

### 44. Why Not Exempt Everything?

We should not simply remove rate limiting.

Health endpoints are infrastructure endpoints.

Incident APIs are business endpoints.

Different workloads require different policies.

This is a recurring production architecture principle:

*Rate limits should be associated with workload characteristics, not blindly applied everywhere.*

---

### 45. Test Health Is Not Rate Limited

Update:
```
tests/security/rate-limit.api.test.ts
```
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
  "API rate limiting",
  () => {

    it(
      "should not apply the incident API limiter to health checks",
      async () => {

        const first =
          await request(app)
            .get("/health/live");

        const second =
          await request(app)
            .get("/health/live");

        expect(first.status)
          .toBe(200);

        expect(second.status)
          .toBe(200);
      }
    );

    it(
      "should expose rate limit headers for incident APIs",
      async () => {

        const response =
          await request(app)
            .get("/incidents");

        expect(response.status)
          .not.toBe(429);

        expect(
          response.headers[
            "ratelimit"
          ]
        ).toBeDefined();
      }
    );
  }
);
```

---

### 46. Run Tests

Run:
```
npm run test:run
```
Then:
```
npm run build
```
Everything should pass.

---

### 47. Rate Limiting Error Contract

We currently return:
```
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests"
  }
}
```
This is consistent with our existing API contract.

Clients can therefore handle:
```
400
404
413
429
500
503
```
using the same general response structure.

---

### 48. Important: Rate Limiting Is Not DDoS Protection

A Node.js rate limiter is useful, but it does not protect us from a large distributed attack by itself.

Consider:
```
10,000 different IP addresses
       │
       ▼
Load Balancer
       │
       ▼
Node.js
```
An application-level IP limiter can still receive huge traffic.

Real production infrastructure may use:
```
CDN
WAF
Cloud load balancer
Network-level protection
Edge rate limiting
Bot protection
```
before traffic reaches Node.js.

Our middleware is an application-level protection layer.

---

### 49. Rate Limiting and Database Protection

This is particularly important for our application.

Consider:
```
POST /incidents
```
The request can trigger:
```
HTTP request
    ↓
Validation
    ↓
Service
    ↓
Transaction
    ↓
INSERT incident
    ↓
INSERT incident event
```
One request may generate multiple database operations.

Therefore:
```
1000 HTTP requests
```
could generate:
```
2000+ database operations
```
depending on the workflow.

Rate limiting protects the database indirectly by controlling upstream workload.

---

### 50. Rate Limiting and Connection Pools

Our PostgreSQL pool currently has:
```
max: 10
```
This means the application has a finite number of database connections.

Rate limiting and connection pooling work together:
```
Client traffic
      ↓
Rate limiter
      ↓
Application
      ↓
Connection pool
      ↓
PostgreSQL
```
Rate limiting controls request volume.

The pool controls database concurrency.

They solve different problems.

---

### 51. Rate Limiting Does Not Replace Concurrency Control

Suppose:
```
10 requests
```
arrive.

Each request launches a slow database operation.

Even with rate limiting, those requests may run concurrently.

Later we will need:
```
connection pooling
timeouts
queueing
worker concurrency
backpressure
```
Rate limiting is only one layer.


---

### 52. Rate Limiting and Backpressure

Backpressure means:

*When downstream systems cannot keep up, upstream work must be slowed or rejected.*

Our eventual architecture will look like:
```
Client
  │
  ▼
Rate Limiter
  │
  ▼
API
  │
  ▼
Queue
  │
  ▼
Workers
  │
  ▼
Database
```
If workers become overloaded:
```
Queue depth increases
```
Eventually we may need:
```
Rate limiting
+
Queue limits
+
Concurrency limits
+
Backpressure
```
This will become extremely important once BullMQ enters this project.

---

### 53. Future Redis-Based Rate Limiting

Our current architecture:
```
Instance A
   │
   └── memory

Instance B
   │
   └── memory
```
Later:
```
Instance A ──┐
              │
Instance B ──┼──► Redis
              │
Instance C ──┘
```
Then all application instances can share rate-limit state.

For example:
```
Client IP
   │
   ▼
Redis key
   │
   ▼
request count
```
This is why Redis is already part of the larger project architecture.

We will not introduce Redis into this lecture just for rate limiting.

---

### 54. Future Identity-Based Limits

After authentication, we may have policies such as:
```
Anonymous:
20 requests/minute

Authenticated user:
100 requests/minute

Premium organization:
1000 requests/minute
```
Or endpoint-specific:
```
GET /incidents
100/minute

POST /incidents
20/minute

Expensive reporting API
5/minute
```
This is much more useful than one global number.

---

### 55. Rate Limiting by User

Eventually the key might be:
```
userId
```
instead of:
```
IP address
```
For example:
```
User 123
   ↓
Redis
   ↓
counter
```
This avoids penalizing multiple users sharing one public IP.

But we need authentication before we can reliably identify the user.

---

### 56. Rate Limiting by Tenant

Our platform may eventually become multi-tenant.

Then:
```
Organization A
Organization B
Organization C
```
may need separate quotas.

Example:
```
Tenant A → 10,000 requests/hour
Tenant B → 50,000 requests/hour
```
The rate-limit key can become:
```
tenantId
```
or:
```
tenantId + route
```
This is a future distributed-system concern.

---

### 57. Rate Limiting and Fairness

Suppose one client sends:
```
10,000 requests
```
while another sends:
```
10 requests
```
Without rate limiting:
```
Noisy client
     ↓
Consumes resources
     ↓
Other clients suffer
```
Rate limiting introduces a form of resource fairness.

This concept becomes even more important in multi-tenant systems.

---

### 58. Security Boundary After Lecture 21

Our application now looks like:

```
                              Client
                                │
                                ▼
                       Security Headers
                                │
                                ▼
                         Body Size Limit
                                │
                                ▼
                          Request ID
                                │
                                ▼
                       Request Logging
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
                 /health                /incidents
                    │                       │
                    │                 Rate Limiter
                    │                       │
                    │                       ▼
                    │                  Validation
                    │                       │
                    │                       ▼
                    │                   Controller
                    │                       │
                    │                       ▼
                    │                    Service
                    │                       │
                    │                       ▼
                    │                 Parameterized SQL
                    │                       │
                    │                       ▼
                    └───────────────── PostgreSQL
```

---

### 59. Testing Architecture

We now have rate-limit tests at two levels.

#### Unit-ish middleware behavior
```
createRateLimiter({
  limit: 2
})
```
Tests:
```
Request 1 → 200
Request 2 → 200
Request 3 → 429

```
#### Application integration
Tests verify:
```
/health
```
is not accidentally rate limited and:
```
/incidents
```
has the limiter applied.

This separation keeps tests fast and focused.

---

### 60. Final Folder Structure

After Lecture 21:
```
production-intelligence-platform/
│
├── src/
│   │
│   ├── config/
│   │   ├── env.ts
│   │   └── rate-limit.ts
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
│   │   ├── security.middleware.ts
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
│   ├── security/
│   │   ├── rate-limit.api.test.ts
│   │   ├── rate-limit.test.ts
│   │   └── security.api.test.ts
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
├── .env.example
├── .gitignore
├── docker-compose.yml
├── package.json
└── tsconfig.json
```
---

### 61. Important Production Limitation

Our current rate limiter is:
```
in-memory
```
Therefore:
```
Instance A
    │
    └── counter A

Instance B
    │
    └── counter B
```
This is not sufficient for a horizontally scaled production system.

Our future architecture will be:
```
                 Load Balancer
                 /     |     \
                ▼      ▼      ▼
              API-A  API-B  API-C
                \      |      /
                 \     |     /
                    Redis
                      │
                      ▼
               Shared counters
```
That will give us distributed rate limiting.

We will introduce that when Redis becomes part of the platform instead of prematurely adding another infrastructure dependency now.

---

### 62. Current Application Security Architecture

After Lectures 20 and 21:
```
                             Client
                               │
                               ▼
                     ┌──────────────────┐
                     │ Security Headers │
                     └────────┬─────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │ Body Size Limit  │
                     └────────┬─────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │   Request ID     │
                     └────────┬─────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │ Request Logging  │
                     └────────┬─────────┘
                              │
                   ┌──────────┴──────────┐
                   │                     │
                   ▼                     ▼
                Health                API Routes
                   │                     │
                   │                     ▼
                   │               Rate Limiter
                   │                     │
                   │                     ▼
                   │                 Validation
                   │                     │
                   │                     ▼
                   │                 Controller
                   │                     │
                   │                     ▼
                   │                  Service
                   │                     │
                   │                     ▼
                   │              Parameterized SQL
                   │                     │
                   └─────────────────────┤
                                         ▼
                                    PostgreSQL
```

---