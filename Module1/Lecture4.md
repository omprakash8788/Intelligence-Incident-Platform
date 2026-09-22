### Lecture 4 — Testing Infrastructure

We've built:

```
Express
   ↓
Routes
   ↓
Controllers
   ↓
Error handling
```

Now we need confidence that these pieces actually work.

Our rule remains:

 - Build → Test → Break → Fix → Continue

---

### 1. Why testing now?

Imagine we later add:

```
PostgreSQL
Redis
BullMQ
Workers
Events
WebSockets
Distributed locks

```

If we don't have tests, a change to one component could silently break another.

We want:

```
                    Tests
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     Routes       Controllers     Errors
        │             │             │
        └─────────────┼─────────────┘
                      ▼
                  Application
```

---

### 2. We'll use Vitest

Install:
```
npm install -D vitest

npm install -D vite

```

We'll use` Vitest` for our testing framework.

Later we'll add an HTTP testing library so we can test actual API requests.

---

### 3. Add test script

Update `package.json`:

```
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

Two useful commands:

### Development
```
npm test
```

Vitest stays running and watches files.

### CI / one-time execution
```
npm run test:run

```

It runs once and exits.

---

### 4. First test — health controller

Create:
```
tests/
└── health.controller.test.ts
```

Add:

```
import { describe, expect, it, vi } from "vitest";
import { healthController } from "../src/controllers/health.controller.js";

describe("healthController", () => {
  it("should return healthy status", () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };

    healthController({} as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);

    expect(res.json).toHaveBeenCalledWith({
      status: "ok",
      service: "production-intelligence-platform"
    });
  });
});
```

Run:

```
npm run test:run
```
You should get something similar to:
```
✓ tests/health.controller.test.ts

Test Files  1 passed
Tests       1 passed
```

---


### 5. Understand what we just tested

We didn't start Express.

We didn't start port `3000.`

We didn't use a browser.

We tested the controller directly.

```
Test
 │
 ▼
healthController()
 │
 ├── status(200)
 │
 └── json(...)


```

This is a unit test

---

### 6. But there is a problem

Our test contains:

```
{} as any
```

and:
```
res as any
```

We're using `any` to simplify the first test.

But remember our production TypeScript rule:

- Avoid any where we can.

We'll improve the testing setup shortly.

For now, understand the testing concept first.

---

### 7. Test AppError

Create:

```
tests/errors/AppError.test.ts
```

```
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/AppError.js";

describe("AppError", () => {
  it("should create a structured application error", () => {
    const error = new AppError(
      "Something went wrong",
      400,
      "TEST_ERROR"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);

    expect(error.message).toBe("Something went wrong");
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("TEST_ERROR");
  });
});
```

Run:

```

npm run test:run

```

Expected:

```

Test Files  2 passed
Tests       2 passed

```
---

### 8. Test NotFoundError

Create:
```
tests/errors/NotFoundError.test.ts
```

```
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/errors/NotFoundError.js";

describe("NotFoundError", () => {
  it("should have status code 404", () => {
    const error = new NotFoundError(
      "Incident not found",
      "INCIDENT_NOT_FOUND"
    );

    expect(error.statusCode).toBe(404);

    expect(error.code).toBe("INCIDENT_NOT_FOUND");

    expect(error.message).toBe("Incident not found");
  });
});

```

Run:

```

npm run test:run

```

---

### 9. Now we test the actual HTTP API

Unit tests are useful, but we also want:

```
Actual HTTP request
       ↓
Express
       ↓
Router
       ↓
Controller
       ↓
Actual HTTP response

```

For this we'll install ***Supertest***.

```

npm install -D supertest @types/supertest

```

---


### 10. Health API integration test

Create:
```
tests/health.api.test.ts
```

```
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("GET /health", () => {
  it("should return 200 and healthy status", async () => {
    const response = await request(app)
      .get("/health");

    expect(response.status).toBe(200);

    expect(response.body).toEqual({
      status: "ok",
      service: "production-intelligence-platform"
    });
  });
});

```
Run:

```

npm run test:run

```


Now we're testing the real request pipeline.

---

### 12. Test unknown route

Create:

```
tests/not-found.api.test.ts
```

```
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("Unknown routes", () => {
  it("should return 404", async () => {
    const response = await request(app)
      .get("/does-not-exist");

    expect(response.status).toBe(404);
  });
});
```

Run:
```
npm run test:run
```

This should pass.

But notice something interesting.

We're getting Express's default 404 behavior.

Eventually we want our own response:


```
{
  "success": false,
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "Route not found"
  }
}
```

We'll implement that next.

---

### 13. Test our error middleware

This is important because error handling is part of the foundation.

Temporarily add this route to `health.routes.ts:`

```
router.get("/test-error", () => {
  throw new NotFoundError(
    "Test incident does not exist",
    "INCIDENT_NOT_FOUND"
  );
});
```

Then create:
```
tests/error.api.test.ts
```

```
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("Error handling", () => {
  it("should return structured 404 error", async () => {
    const response = await request(app)
      .get("/health/test-error");

    expect(response.status).toBe(404);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INCIDENT_NOT_FOUND",
        message: "Test incident does not exist"
      }
    });
  });
});
```


Run:
```
npm run test:run
```

The exact count can differ depending on how you've organized the earlier tests, but all tests should pass.

---

### 14. Now intentionally break the application

This is an important part of our learning process.

Go to:
```
src/controllers/health.controller.ts
```

Change:
```
res.status(200)
```

to:
```
res.status(201)
```

Run:

```

npm run test:run

```

Your health test should fail.

Something like:

```
Expected: 200
Received: 201
```

That's good.

The test caught our regression.

Change it back:

```
res.status(200)
```
Run:

```

npm run test:run

```

Everything should pass again.

---

15. Current project structure

You should now have approximately:

```
production-intelligence-platform/
│
├── src/
│   ├── app.ts
│   ├── server.ts
│   │
│   ├── controllers/
│   │   └── health.controller.ts
│   │
│   ├── routes/
│   │   └── health.routes.ts
│   │
│   ├── errors/
│   │   ├── AppError.ts
│   │   ├── NotFoundError.ts
│   │   └── ValidationError.ts
│   │
│   └── middleware/
│       └── error.middleware.ts
│
├── tests/
│   ├── health.controller.test.ts
│   ├── health.api.test.ts
│   ├── not-found.api.test.ts
│   ├── error.api.test.ts
│   │
│   └── errors/
│       ├── AppError.test.ts
│       └── NotFoundError.test.ts
│
├── package.json
├── tsconfig.json
└── package-lock.json
```

---

### What you learned

There are two important testing levels so far.

### Unit test

Tests one component:

```
healthController
       ↓
expected behavior

```

### API / integration test

Tests several components together:

```
HTTP
 ↓
Express
 ↓
Router
 ↓
Controller
 ↓
Response

```

Neither replaces the other.

---

### One cleanup before Lecture 5

After you've verified the error test, remove this temporary route:


```
routes/health.route.ts

router.get("/test-error", () => {
  throw new NotFoundError(...);
});

```

Also remove its now-unused import:

```

import { NotFoundError } from "../errors/NotFoundError.js";

```

We don't want artificial test endpoints in our production API.

Our tests will eventually use dedicated test routes or controlled test dependencies rather than exposing debugging endpoints.



---





