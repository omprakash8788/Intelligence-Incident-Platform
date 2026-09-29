# Module 1 — Lecture 20: Security Fundamentals

> **Project:** Production Intelligence & Incident Platform  
> **Stack:** Node.js + TypeScript + Express + PostgreSQL  
> **Architecture principle:** Security must be built into the application boundary, not added after the application is finished.

---

# 1. Lecture Objective

Our application currently has:

- Express
- TypeScript
- PostgreSQL
- database transactions
- validation middleware
- structured logging
- request IDs
- graceful shutdown
- liveness checks
- readiness checks

But we have not yet established a proper security boundary.

Our application currently accepts HTTP requests like:

```text
Client
   │
   ▼
Express
   │
   ▼
Controller
   │
   ▼
Service
   │
   ▼
PostgreSQL

```

We need to harden the boundary:

```
Client
   │
   ▼
┌─────────────────────────────┐
│       Security Boundary     │
│                             │
│ Headers                     │
│ Body limits                 │
│ Input validation            │
│ SQL parameterization        │
│ Error sanitization          │
│ Secret protection           │
│ Request identification      │
└──────────────┬──────────────┘
               │
               ▼
          Application

```

---

### 2. Security Is Not One Feature

Security is not:

```
npm install security-package
```

Security is a collection of layers.

For this project we will establish:

```
1. HTTP security headers
2. Request body size limits
3. Content-Type handling
4. Input validation
5. SQL injection protection
6. Error information protection
7. Secret management
8. Request ID safety
9. Security-focused tests
```

Later we will add:

```
Authentication
Authorization
Rate limiting
Session/token security
Audit logging
Network security
Redis security
Queue security
```

We are intentionally not implementing authentication in this lecture.

---

### 3. Security Boundary

Our request pipeline should eventually look like:

```
   HTTP Request
                         │
                         ▼
                 Request ID
                         │
                         ▼
              Security Middleware
                         │
                         ▼
              Body Parser Limits
                         │
                         ▼
                 Route Validation
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
                   PostgreSQL
```
The important principle is:

**Validate and constrain untrusted input as close to the application boundary as possible.**

---

### 4. What Is Untrusted Input?

Anything supplied by a client should be considered untrusted.

Examples:
```
URL parameters
Query parameters
Request body
Headers
Cookies
Uploaded files
Authentication tokens
```
For example:
```
POST /incidents
Content-Type: application/json

{
  "service": "payment-service",
  "severity": "critical"
}
```
Both:
```
service
severity
```
came from the client.
Therefore they must be validated.

---

### 5. Security Layer 1 — HTTP Headers

HTTP response headers can communicate security policies to browsers.

For example:
```
X-Content-Type-Options
X-Frame-Options
Referrer-Policy
Content-Security-Policy
```
Instead of manually implementing every header, we can use a well-established Express security middleware.

We will use:
```
helmet
```

--- 

### 6. Install Helmet

From the project root:
```
npm install helmet
```
Verify:
```
npm ls helmet
```
You should see the installed package.

---

### 7. Why Helmet?

Helmet sets a collection of security-related HTTP headers.

For example, depending on configuration, it can help establish policies related to:
```
Content type sniffing
Clickjacking
Referrer information
Content Security Policy
Browser security behavior
```
It does not magically secure the application.

It is one layer.

---

### 8. Create Security Middleware

Create:
```
src/middleware/security.middleware.ts
```
Complete file:
```
import helmet from "helmet";

export const securityMiddleware =
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });
```

---

### 9. Why Disable These Two Defaults?

We are deliberately starting with a conservative backend API configuration.

We disable:
```
contentSecurityPolicy: false
```
because our application is currently an API rather than a browser-rendered frontend.

We also disable:
```
crossOriginEmbedderPolicy: false
```
because enabling browser isolation policies without understanding the frontend/resource requirements can create unexpected behavior.

This does **not** mean these protections are bad.

It means:

**Security policies should be configured according to the actual application architecture.**

Later, when we build the React frontend, we can establish the appropriate browser security policy.

---

### 10. Register Security Middleware
#### File
```
src/app.ts
```
Replace the complete file with:

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
  requestIdMiddleware
} from "./middleware/request-id.middleware.js";

import {
  requestLoggingMiddleware
} from "./middleware/request-logging.middleware.js";

import {
  securityMiddleware
} from "./middleware/security.middleware.js";

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

### 11. Why Security Middleware Comes First

Our pipeline is now:
```
Security headers
       ↓
JSON body parser
       ↓
Request ID
       ↓
Request logging
       ↓
Routes
       ↓
404
       ↓
Error handler
```
Security middleware is registered before application routes.

This means the security-related response headers can be applied broadly.

---

### 12. Security Layer 2 — Request Body Limits

Our previous code used:
```
express.json()
```
This accepts JSON bodies without us explicitly defining an application-level size limit.

We now use:
```
express.json({
  limit: "100kb"
})
```
This is important because request bodies consume memory.

---

### 13. Why Body Limits Matter

Imagine a client sends:
```
POST /incidents
```
with an enormous request body.

For example:
```
100 MB
500 MB
1 GB
```
Even if our application eventually rejects the data, the server may have already spent resources receiving/parsing it.

This creates unnecessary resource consumption.

Therefore:
```
Unbounded input
```
should become:
```
Bounded input
```

---

### 14. Why 100 KB?

For this application:
```
100kb
```
is intentionally conservative.

Our current incident creation payload is tiny:
```
{
  "service": "payment-service",
  "severity": "critical"
}
```
We don't need megabytes of JSON.

Later, if the API legitimately needs large payloads, we can change the limit based on actual requirements.

Do not blindly increase the limit.

---

### 15. Security Layer 3 — Content-Type

Our API expects JSON.

For example:
```
Content-Type: application/json
```
Express's JSON parser handles JSON requests.

But clients can send unexpected content types.

Our route-level validation should not assume that arbitrary data is valid JSON application data.

We should therefore test:
```
JSON
non-JSON
oversized JSON
malformed JSON
```

---

### 16. Security Layer 4 — Input Validation

We already have:
```
src/validators/
```
with:
```
incident.validator.ts
incident-query.validator.ts
```
This is good.

For example:
```
if (
  typeof service !== "string" ||
  service.trim().length === 0
) {
  throw new ValidationError(
    "Service is required",
    "SERVICE_REQUIRED"
  );
}
```
The important principle is:
```
Client input
    ↓
Validation
    ↓
Business logic
```
not:
```
Client input
    ↓
Database
```

---

### 17. Validation Must Have Boundaries

Our current validator checks:
```
service exists
severity is valid
```
But it doesn't have a maximum service length.

Someone could send:
```
{
  "service": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..."
}
```
We should establish a domain boundary.

Our database already defines:
```
service VARCHAR(100)
```
Therefore the API should reject service names longer than 100 characters.

---

### 18. Update Incident Validator
#### File
```
src/validators/incident.validator.ts
```

Replace the complete file with:
```
import { Request } from "express";

import {
  ValidationError
} from "../errors/ValidationError.js";

const validSeverities = [
  "low",
  "medium",
  "high",
  "critical"
] as const;

const MAX_SERVICE_LENGTH = 100;

export const validateCreateIncident = (
  req: Request
) => {

  const {
    service,
    severity
  } = req.body;

  if (
    typeof service !== "string" ||
    service.trim().length === 0
  ) {
    throw new ValidationError(
      "Service is required",
      "SERVICE_REQUIRED"
    );
  }

  const normalizedService =
    service.trim();

  if (
    normalizedService.length >
    MAX_SERVICE_LENGTH
  ) {
    throw new ValidationError(
      "Service must not exceed 100 characters",
      "SERVICE_TOO_LONG"
    );
  }

  if (
    !validSeverities.includes(
      severity
    )
  ) {
    throw new ValidationError(
      "Invalid severity",
      "INVALID_SEVERITY"
    );
  }
};
```

---

### 19. Why Validate Before Database?

Our database has:
```
VARCHAR(100)
```
The database will protect the data.

But application validation gives the client a meaningful API error.

Without application validation:
```
Request
   ↓
Controller
   ↓
Database
   ↓
Database error
```
With application validation:
```
Request
   ↓
Validator
   ↓
400 SERVICE_TOO_LONG
```

The database remains the final integrity boundary.

The API remains the user-facing validation boundary.

---

### 20. Defense in Depth

We now have:
```
Client
  │
  ▼
API validation
  │
  ▼
Service
  │
  ▼
Parameterized SQL
  │
  ▼
Database constraints
```
Multiple layers protect the system.

This is called:

**Defense in depth.**

---

### 21. Security Layer 5 — SQL Injection

One of the most important backend security vulnerabilities is SQL injection.

Bad:
```
const sql = `
  SELECT *
  FROM incidents
  WHERE service = '${service}'
`;
```
If the client sends malicious SQL syntax, the generated SQL can become unsafe.

---

### 22. Our Current Approach

Our repository already uses:
```
const query = `
  SELECT ...
  FROM incidents
  WHERE service = $1
`;

const values = [
  service
];

await pool.query(
  query,
  values
);
```
This is the correct pattern.

The SQL structure is separated from the values.

---

### 23. Parameterized Query

For example:
```
const result = await pool.query(
  `
    SELECT *
    FROM incidents
    WHERE service = $1
  `,
  [
    service
  ]
);
```
The client-controlled value is:
```
$1
```
not inserted directly into SQL text.

This protects the query structure.

---

### 24. Important Rule

Never do this:
```
const sql =
  `SELECT *
   FROM incidents
   WHERE service = '${service}'`;
```
Prefer:
```
const sql =
  `SELECT *
   FROM incidents
   WHERE service = $1`;

const values = [
  service
];
```
This rule applies to:
```
SELECT
INSERT
UPDATE
DELETE
JOIN filters
WHERE clauses
```
whenever user-controlled values are involved.

---

### 25. Security Layer 6 — Dynamic SQL

Sometimes developers think parameterization means:
```
ORDER BY $1
```
can be used for everything.

It cannot safely solve every dynamic SQL problem.

For example, SQL identifiers such as:
```
column names
table names
sort direction
```
often need explicit allowlists.

Our current repository uses fixed SQL structure:
```
ORDER BY created_at DESC, id DESC
```
This is safer.

---

### 26. If We Need Dynamic Sorting Later

Bad:
```
const sql = `
  SELECT *
  FROM incidents
  ORDER BY ${req.query.sort}
`;
```
Instead:
```
const allowedSortFields = {
  createdAt: "created_at",
  service: "service",
  severity: "severity"
} as const;
```
Then map:
```
const sortColumn =
  allowedSortFields[
    requestedSort
  ];
```
The client can select only known values.
This is an allowlist.

---

### 27. Security Layer 7 — Error Information Leakage

Our error middleware already hides unexpected errors:
```
{
  "success": false,
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "Internal server error"
  }
}
```
This is good.

We should not return:
```
database hostname
password
SQL statement
stack trace
filesystem path
internal implementation details
```
to clients.

---

### 28. What Developers Should See vs Clients

Server logs can contain:
```
{
  "error": "duplicate key value violates unique constraint...",
  "requestId": "..."
}
```
The client should receive:
```
{
  "success": false,
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "Internal server error"
  }
}
```
This creates separation:
```
Client
   ↓
Safe public error

Server
   ↓
Detailed diagnostic log
```

---

### 29. Request ID Helps Error Investigation

We implemented request IDs in Lecture 17.

Now security and observability work together.

Client receives:
```
X-Request-ID: ABC
```
Server logs:
```
{
  "requestId": "ABC",
  "error": "..."
}
```
The client can report:
```
Request ID: ABC
```
and an operator can find the corresponding server-side logs.

---

### 30. Security Layer 8 — Secrets

Our **.env** currently contains:
```
POSTGRES_PASSWORD=postgres
```
This is acceptable only as a local development credential.

We must never commit:
```
real production passwords
API keys
JWT secrets
private keys
cloud credentials
database passwords
```
to Git.

---

### 31. Verify .gitignore
#### File
```
.gitignore
```
It should contain:
```
node_modules/
dist/
.env
coverage/
```
The important line is:
```
.env
```

---

### 32. Why .env.example Is Useful

We should provide developers with the required configuration shape without exposing secrets.

Create:
```
.env.example
```
Complete file:
```
NODE_ENV=development
PORT=3000

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
```
This file can be committed.

The real:
```
.env
```
must remain ignored.

---

### 33. Secret Management Principle

Development:
```
.env
```
Production:
```
Secret Manager
Environment Variables
Platform Secret Store
```
Later, depending on deployment architecture, we can use appropriate secret-management infrastructure.

The application should read secrets from configuration.

It should not hardcode:
```
const password = "postgres";
```

---

### 34. Security Layer 9 — Request ID Header Validation

Our request ID middleware currently accepts only UUID-shaped IDs.

This is important.

We don't want:
```
X-Request-ID: <arbitrary huge value>
```
or:
```
X-Request-ID: <unexpected control characters>
```
Our UUID allowlist avoids those cases.

This is another example of input validation.

---

### 35. Security Layer 10 — HTTP Method Handling

Our routes explicitly define methods:
```
POST /incidents
GET /incidents
GET /incidents/:id
```
We should not implement generic handlers that accidentally accept methods we don't need.

For example:
```
DELETE
PATCH
PUT
```
should not magically exist.

Express routing already gives us a strong boundary here.

---

### 36. Security Layer 11 — 404 Handling

Unknown routes should return:
```
404
```
through:
```
src/middleware/not-found.middleware.ts
```
For example:
```
GET /admin-secret-data
```
should not expose:
```
filesystem information
Express internals
stack traces
```
Our existing error middleware returns the safe API error format.

---

### 37. Add Security Tests

Create:
```
tests/security/security.api.test.ts
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
  "Security API",
  () => {

    it(
      "should include security headers",
      async () => {

        const response =
          await request(app)
            .get("/health/live");

        expect(
          response.headers[
            "x-content-type-options"
          ]
        ).toBe("nosniff");

        expect(
          response.headers[
            "x-frame-options"
          ]
        ).toBeDefined();

        expect(
          response.headers[
            "referrer-policy"
          ]
        ).toBeDefined();
      }
    );

    it(
      "should reject an oversized JSON body",
      async () => {

        const largeService =
          "a".repeat(101);

        const response =
          await request(app)
            .post("/incidents")
            .send({
              service:
                largeService,
              severity:
                "critical"
            });

        expect(response.status)
          .toBe(400);

        expect(response.body)
          .toEqual({
            success: false,
            error: {
              code:
                "SERVICE_TOO_LONG",
              message:
                "Service must not exceed 100 characters"
            }
          });
      }
    );

    it(
      "should reject an invalid severity",
      async () => {

        const response =
          await request(app)
            .post("/incidents")
            .send({
              service:
                "payment-service",
              severity:
                "extreme"
            });

        expect(response.status)
          .toBe(400);

        expect(response.body)
          .toEqual({
            success: false,
            error: {
              code:
                "INVALID_SEVERITY",
              message:
                "Invalid severity"
            }
          });
      }
    );

    it(
      "should not expose internal details for unknown routes",
      async () => {

        const response =
          await request(app)
            .get(
              "/this-route-does-not-exist"
            );

        expect(response.status)
          .toBe(404);

        expect(
          response.body.error.message
        ).not.toContain(
          "Error:"
        );

        expect(
          response.body.error.message
        ).not.toContain(
          "node_modules"
        );

        expect(
          response.body.error.message
        ).not.toContain(
          "src/"
        );
      }
    );
  }
);
```
---

### 38. Important Correction About "Oversized"

The test above uses:
```
101 characters
```
for the *service* field.

That is **not** testing the HTTP body-size limit.

It is testing the domain validation limit:
```
VARCHAR(100)
```
We need a separate test for the actual:
```
100 KB
```
JSON body limit.

---

### 39. Test the JSON Body Limit

Add this test to:
```
tests/security/security.api.test.ts
```
Inside the existing *describe*:

```
it(
  "should reject a request body larger than the configured limit",
  async () => {

    const largeValue =
      "x".repeat(
        110 * 1024
      );

    const response =
      await request(app)
        .post("/incidents")
        .send({
          service:
            "payment-service",
          severity:
            "critical",
          extraData:
            largeValue
        });

    expect(response.status)
      .toBe(413);
  }
);
```
The important difference is:
```
101 characters
```
versus:
```
110 KB
```
The first is domain validation.

The second is HTTP body protection.

---

### 40. Run Security Tests

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

### 41. Potential JSON Parser Error

There is an important issue with oversized JSON requests.

Express's body parser can reject them before our application-level error middleware receives a normal *AppError*.

The resulting error may have:
```
413
```
but not necessarily our normal:
```
{
  "success": false,
  "error": {
    "code": "...",
    "message": "..."
  }
}
```
This is something we should fix.

---

### 42. Handle Payload Too Large

We need to extend the error middleware.

#### File
```
src/middleware/error.middleware.ts
```

Replace the complete file with:

```
import {
  Request,
  Response,
  NextFunction
} from "express";

import { AppError } from "../errors/AppError.js";

import { logger } from "../logging/logger.js";

import type {
  ApiErrorResponse
} from "../types/api-response.js";

export const errorMiddleware = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {

  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    err.type ===
      "entity.too.large"
  ) {

    logger.warn(
      "Request payload too large",
      {
        method:
          req.method,
        path:
          req.originalUrl
      }
    );

    const response:
      ApiErrorResponse = {
        success: false,
        error: {
          code:
            "PAYLOAD_TOO_LARGE",
          message:
            "Request payload is too large"
        }
      };

    res
      .status(413)
      .json(response);

    return;
  }

  if (
    err instanceof AppError
  ) {

    logger.warn(
      "Application error",
      {
        method:
          req.method,
        path:
          req.originalUrl,
        code:
          err.code,
        statusCode:
          err.statusCode,
        message:
          err.message
      }
    );

    const response:
      ApiErrorResponse = {
        success: false,
        error: {
          code:
            err.code,
          message:
            err.message
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
      method:
        req.method,
      path:
        req.originalUrl,
      error:
        err instanceof Error
          ? err.message
          : String(err)
    }
  );

  res
    .status(500)
    .json({
      success: false,
      error: {
        code:
          "INTERNAL_SERVER_ERROR",
        message:
          "Internal server error"
      }
    });
};
```

---

### 43. Why Check err.type?

The Express body parser generates an error object containing:
```
type = entity.too.large
```
We don't want to expose the parser's internal message directly.

Instead:
```
Internal parser error
       ↓
Safe API error
```
We return:
```
{
  "success": false,
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Request payload is too large"
  }
}
```

---

### 44. Test Again

Run:
```
npm run test:run
```
Then:
```
npm run build
```
The payload-size test should now expect our standardized error response.

Update the test to verify it.

#### File
```
tests/security/security.api.test.ts
```
Replace the payload-size test with:
```
it(
  "should reject a request body larger than the configured limit",
  async () => {

    const largeValue =
      "x".repeat(
        110 * 1024
      );

    const response =
      await request(app)
        .post("/incidents")
        .send({
          service:
            "payment-service",
          severity:
            "critical",
          extraData:
            largeValue
        });

    expect(response.status)
      .toBe(413);

    expect(response.body)
      .toEqual({
        success: false,
        error: {
          code:
            "PAYLOAD_TOO_LARGE",
          message:
            "Request payload is too large"
        }
      });
  }
);
```
---

### 45. Malformed JSON

Another security boundary is malformed JSON.

For example:
```
{
  "service": "payment-service"
```
is invalid JSON.

We should return a controlled error rather than expose parser internals.

Add another test:

#### File
```
tests/security/security.api.test.ts
```
Add:

```
it(
  "should reject malformed JSON safely",
  async () => {

    const response =
      await request(app)
        .post("/incidents")
        .set(
          "Content-Type",
          "application/json"
        )
        .send(
          '{"service":"payment-service"'
        );

    expect(response.status)
      .toBe(400);

    expect(response.body)
      .toEqual({
        success: false,
        error: {
          code:
            "INVALID_JSON",
          message:
            "Invalid JSON payload"
        }
      });
  }
);
```
---

### 46. Handle Malformed JSON

Update:
```
src/middleware/error.middleware.ts
```
Add this block **before** the *AppError* block:
```
if (
  err &&
  typeof err === "object" &&
  "type" in err &&
  err.type ===
    "entity.parse.failed"
) {

  logger.warn(
    "Invalid JSON payload",
    {
      method:
        req.method,
      path:
        req.originalUrl
    }
  );

  const response:
    ApiErrorResponse = {
      success: false,
      error: {
        code:
          "INVALID_JSON",
        message:
          "Invalid JSON payload"
      }
    };

  res
    .status(400)
    .json(response);

  return;
}
```

The error flow becomes:
```
Malformed JSON
      ↓
Express parser
      ↓
error middleware
      ↓
INVALID_JSON
      ↓
400
```

---

### 47. Run Tests Again

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

### 48. Intentional Break #1 — Remove Helmet

Now deliberately remove:
```
app.use(
  securityMiddleware
);
```
from:
```
src/app.ts
```
Run:
```
npm run test:run
```
The security-header test should fail.

Restore:
```
app.use(
  securityMiddleware
);
```
Run:
```
npm run test:run
```
The test should pass.

---

### 49. Intentional Break #2 — Remove Body Limit

Temporarily change:
```
express.json({
  limit: "100kb"
})
```
to:
```
express.json()
```
Run:
```
npm run test:run
```
The payload-size test should fail.

Restore:
```
express.json({
  limit: "100kb"
})
```

Run:
```
npm run test:run
```
The test should pass again.

---

### 50. Intentional Break #3 — Break Validation

Temporarily remove:
```
if (
  normalizedService.length >
  MAX_SERVICE_LENGTH
) {
  throw new ValidationError(
    "Service must not exceed 100 characters",
    "SERVICE_TOO_LONG"
  );
}
```
Run:
```
npm run test:run
```
The service-length security test should fail.

Restore the validation.

Run:
```
npm run test:run
```

It should pass again.

---

### 51. SQL Injection Review

We are going to inspect the repository.

#### File
```
src/repositories/incident.repository.ts
```
Search for SQL construction involving user input.

Our desired pattern is:
```
conditions.push(
  `service = $${parameterIndex}`
);

values.push(service);
```
and:
```
await pool.query(
  sql,
  values
);
```
This is safe parameterization.

---

### 52. What We Must Never Introduce

Do not change this:
```
conditions.push(
  `service = $${parameterIndex}`
);

values.push(service);
```
into:
```
conditions.push(
  `service = '${service}'`
);
```
Likewise, never construct:
```
const sql = `
  SELECT *
  FROM incidents
  WHERE id = '${id}'
`;
```
Use:

```
const sql = `
  SELECT *
  FROM incidents
  WHERE id = $1
`;

await pool.query(
  sql,
  [id]
);
```

---

### 53. SQL Injection Test

Add a test to:
```
tests/incidents.api.test.ts
```
or your existing incident API test file.

Use:

```
it(
  "should safely handle SQL-like service input",
  async () => {

    const maliciousValue =
      "payment-service' OR '1'='1";

    const response =
      await request(app)
        .get("/incidents")
        .query({
          service:
            maliciousValue
        });

    expect(response.status)
      .toBe(200);

    expect(response.body.success)
      .toBe(true);
  }
);


```
The important point is not that this particular string is magically malicious.

The important point is:
```
It must remain a value.
```
It must not become executable SQL.

---

### 54. Why This Test Is Useful

If someone accidentally changes:
```
WHERE service = $1
```
into unsafe string concatenation, this type of test can expose unexpected behavior.

The best defense remains:
```
Parameterized queries
```
rather than trying to maintain a blacklist of malicious strings.

---

### 55. Do Not Build SQL Security Using Blacklists

Bad approach:
```
if (
  input.includes("DROP")
) {
  reject();
}
```
This is not SQL injection protection.

Attackers can use many representations and SQL constructs.

The correct architectural defense is:
```
Parameterized SQL
+
Allowlisted SQL identifiers
+
Input validation
```
---

### 56. Security Headers Manual Verification

Start:
```
npm run dev
```
Then:
```
curl -i http://localhost:3000/health/live
```
Look for headers such as:
```
X-Content-Type-Options: nosniff
X-Frame-Options: ...
Referrer-Policy: ...
```
Exact headers may vary depending on the Helmet version/configuration.

---

### 57. Body Limit Manual Verification

Generate a large payload and send it.

For example, PowerShell:
```
$large = "x" * 112000

$body = @{
    service = "payment-service"
    severity = "critical"
    extraData = $large
} | ConvertTo-Json

Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3000/incidents" `
    -ContentType "application/json" `
    -Body $body
```
The request should be rejected with:
```
413
```
and:

```
{
  "success": false,
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Request payload is too large"
  }
}
```

---

### 58. Malformed JSON Manual Verification

Use a raw HTTP client capable of sending malformed JSON.

Expected behavior:
```
HTTP 400
```
with:
```
{
  "success": false,
  "error": {
    "code": "INVALID_JSON",
    "message": "Invalid JSON payload"
  }
}
```

The client should not receive:
```
SyntaxError
stack trace
filesystem path
internal parser details
```
---

### 59. Security and Logging

We should be careful about logging sensitive data.

Bad:
```
logger.info(
  "Login request",
  {
    password:
      req.body.password
  }
);
```
Never log:
```
Passwords
Access tokens
Refresh tokens
API keys
Session secrets
Private keys
Database passwords
```
Even structured logs can become a security incident if sensitive values are logged.

---

### 60. Our Current Logger Is Generic

Our logger accepts:
```
metadata?: LogMetadata
```
That means developers can accidentally do:
```
logger.info(
  "Something",
  req.body
);
```
We should establish a project rule:

*Never pass raw request bodies, authorization headers, cookies, or secrets into the logger.*

Instead log only the fields necessary for diagnosis.

Good:

```
logger.info(
  "Incident created",
  {
    incidentId,
    service,
    severity
  }
);
```
Bad:
```
logger.info(
  "Incident created",
  req.body
);
```

---

### 61. Security and Request IDs

Our request ID is safe because we only accept UUID-shaped values.

A request:
```
X-Request-ID: ABC
```
does not become a valid incoming identifier.

The middleware generates a new UUID.

This prevents arbitrary data from becoming a trusted correlation value.

---

### 62. Security and Error Responses

Our API has a consistent error contract:
```
{
  "success": false,
  "error": {
    "code": "...",
    "message": "..."
  }
}
```
Security-sensitive failures now include:
```
PAYLOAD_TOO_LARGE
INVALID_JSON
SERVICE_TOO_LONG
INVALID_SEVERITY
```
while unexpected internal failures remain:
```
INTERNAL_SERVER_ERROR
```

---

### 63. Security Layers We Now Have

Our application boundary is now:

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
                   ▼
             Validation
                   │
                   ▼
             Controller
                   │
                   ▼
               Service
                   │
                   ▼
       Parameterized SQL
                   │
                   ▼
             PostgreSQL


```
This is significantly stronger than:
```
Client → Express → PostgreSQL
```

---

### 64. What We Are NOT Implementing Yet

This lecture deliberately does not implement:
```
Authentication
Authorization
JWT
OAuth
API keys
Rate limiting
CSRF
CORS policy
Redis authentication
TLS termination
Network policies
Audit trail
RBAC
```
These deserve dedicated lectures.

Do not try to solve everything inside one middleware.

---

### 65. Why Authentication Comes Later

Authentication asks:
```
Who are you?
```
Authorization asks:
```
What are you allowed to do?
```
Security fundamentals first establish:
```
Can the application safely process untrusted requests?
```
We need that foundation before introducing identity and access control.

---

### 66. Verify Environment Secrets

Check that *.env* is ignored:
```
git status --ignored
```
You should see *.env* among ignored files if the repository is initialized and Git is configured appropriately.

Never run:
```
git add .env
```
for real credentials.

---

### 67. Verify No Hardcoded Database Password

Search the source tree for:
```
POSTGRES_PASSWORD
```
The application should obtain it from:
```
process.env
```
through:
```
src/config/env.ts
```
It should not contain:
```
password: "real-production-password"
```

---

### 68. Final Folder Structure

After Lecture 20, the important structure should be:
```
production-intelligence-platform/
│
├── src/
│ │
│ ├── config/
│ │ └── env.ts
│ │
│ ├── controllers/
│ │ ├── health.controller.ts
│ │ └── incident.controller.ts
│ │
│ ├── database/
│ │ ├── migrations/
│ │ ├── health.ts
│ │ ├── migrate.ts
│ │ ├── pool.ts
│ │ └── transaction.ts
│ │
│ ├── domain/
│ │ ├── incident.ts
│ │ ├── incident-query.ts
│ │ └── pagination.ts
│ │
│ ├── errors/
│ │ ├── AppError.ts
│ │ ├── NotFoundError.ts
│ │ └── ValidationError.ts
│ │
│ ├── logging/
│ │ ├── log-level.ts
│ │ ├── logger.ts
│ │ └── request-context.ts
│ │
│ ├── middleware/
│ │ ├── error.middleware.ts
│ │ ├── not-found.middleware.ts
│ │ ├── request-id.middleware.ts
│ │ ├── request-logging.middleware.ts
│ │ ├── security.middleware.ts
│ │ └── validation.middleware.ts
│ │
│ ├── repositories/
│ │ ├── incident-event.repository.interface.ts
│ │ ├── incident-event.repository.ts
│ │ ├── incident.repository.interface.ts
│ │ └── incident.repository.ts
│ │
│ ├── routes/
│ │ ├── health.routes.ts
│ │ └── incident.routes.ts
│ │
│ ├── server/
│ │ ├── lifecycle.ts
│ │ └── shutdown.ts
│ │
│ ├── services/
│ │ └── incident.service.ts
│ │
│ ├── types/
│ │ └── api-response.ts
│ │
│ ├── utils/
│ │ └── api-response.ts
│ │
│ ├── validators/
│ │ ├── incident-query.validator.ts
│ │ └── incident.validator.ts
│ │
│ ├── app.ts
│ ├── container.ts
│ └── server.ts
│
├── tests/
│ │
│ ├── controllers/
│ │ └── health.controller.test.ts
│ │
│ ├── logging/
│ │ ├── logger.test.ts
│ │ ├── request-context.test.ts
│ │ └── request-logging.middleware.test.ts
│ │
│ ├── middleware/
│ │ └── request-id.middleware.test.ts
│ │
│ ├── security/
│ │ └── security.api.test.ts
│ │
│ ├── server/
│ │ ├── lifecycle.test.ts
│ │ └── shutdown.test.ts
│ │
│ ├── health/
│ │ └── health.api.test.ts
│ │
│ ├── request-id.api.test.ts
│ ├── request-id.error.api.test.ts
│ └── ...
│
├── .env
├── .env.example
├── .gitignore
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---

### 69. Intentional Break → Fix → Verify

We performed three deliberate failures.

#### Break 1

Removed Helmet.

Result:
```
Security-header test failed.
```
Fix:
```
app.use(
  securityMiddleware
);
```
#### Break 2

Removed:
```
limit: "100kb"
```
Result:
```
Payload-size test failed.
```
Fix:
```
express.json({
  limit: "100kb"
})
```
#### Break 3

Removed service length validation.

Result:
```
SERVICE_TOO_LONG test failed.
```
Fix:
```
if (
  normalizedService.length >
  MAX_SERVICE_LENGTH
) {
  throw new ValidationError(
    "Service must not exceed 100 characters",
    "SERVICE_TOO_LONG"
  );
}
```
This is the workflow we want throughout the project:
```
BUILD
  ↓
TEST
  ↓
BREAK
  ↓
OBSERVE FAILURE
  ↓
UNDERSTAND
  ↓
FIX
  ↓
TEST AGAIN
```

---

### 70. Lecture 20 — Final Architecture

After this lecture, the request lifecycle is:
```
                         Client
                           │
                           ▼
                  ┌────────────────┐
                  │ Security Headers│
                  └───────┬────────┘
                          │
                          ▼
                  JSON Body Limit
                          │
                          ▼
                    Request ID
                          │
                          ▼
                  Request Logging
                          │
                          ▼
                      Routing
                          │
                          ▼
                     Validation
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
                 Parameterized SQL
                          │
                          ▼
                      PostgreSQL
```
Errors travel back through:
```
PostgreSQL
    ↓
Repository
    ↓
Service
    ↓
Controller
    ↓
Error Middleware
    ↓
Safe API Response
```
while detailed diagnostic information stays in server-side logs.

