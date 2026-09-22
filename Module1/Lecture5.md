### Lecture 5 — 404 Handling, Validation & API Contracts

So far we have:

```
Express
 ↓
Routes
 ↓
Controllers
 ↓
Error classes
 ↓
Global error middleware
 ↓
Tests
```

Today we'll make the API contract more consistent.

By the end:

```
Unknown route
      ↓
404 middleware
      ↓
AppError
      ↓
Global error middleware
      ↓
Consistent JSON

```

And we'll introduce request validation without adding unnecessary libraries yet.

---

### 1. Problem: Unknown routes

Currently:

```
GET /something-that-does-not-exist
```

is handled by Express's default 404 behavior.

We don't want framework-generated responses mixed with our API responses.

We want:

```
{
  "success": false,
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "Route not found"
  }
}
```

So every error follows our contract.

---

### 2. Create `NotFoundMiddleware`

Create:
```
src/middleware/not-found.middleware.ts
```

```
import { Request, Response, NextFunction } from "express";
import { NotFoundError } from "../errors/NotFoundError.js";

export const notFoundMiddleware = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  next(
    new NotFoundError(
      `Route ${req.method} ${req.originalUrl} not found`,
      "ROUTE_NOT_FOUND"
    )
  );
};
```

Notice something important:

We're ***not sending the response here.***

We're doing:

```
404 Middleware
      ↓
NotFoundError
      ↓
Global Error Middleware
```

This means there is still **only one place responsible for formatting errors.**

---

### 3. Register it correctly

Open:

```
src/app.ts

```

Change it to:

```
import express from "express";
import healthRoutes from "./routes/health.routes.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";
import { errorMiddleware } from "./middleware/error.middleware.js";

const app = express();

app.use(express.json());

app.use("/health", healthRoutes);

app.use(notFoundMiddleware);

app.use(errorMiddleware);

export default app;
```

The order is extremely important.

```
                    Request
                       │
                       ▼
                 Express JSON
                       │
                       ▼
                     Routes
                       │
             ┌─────────┴─────────┐
             │                   │
           Found               Not Found
             │                   │
             ▼                   ▼
        Controller       notFoundMiddleware
             │                   │
             │                   ▼
             │             NotFoundError
             │                   │
             └─────────┬─────────┘
                       ▼
               errorMiddleware
                       │
                       ▼
                    Response
```

---

### 4. Test the new 404 behavior

Our existing test:
```
tests/not-found.api.test.ts
```

should now be:
```
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("Unknown routes", () => {
  it("should return structured 404 error", async () => {
    const response = await request(app)
      .get("/does-not-exist");

    expect(response.status).toBe(404);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route GET /does-not-exist not found"
      }
    });
  });
});
```

### Note - removed this file from tests folder `tests/error.api.test.ts`

Then run 

Run:
```
npm run test:run
```
Expected:
```
✓ Unknown routes
```


### 5. Why middleware order matters

Suppose we did this:

```

app.use(errorMiddleware);

app.use(notFoundMiddleware);

```

Then the error middleware would execute before the 404 middleware generates its error.

The request flow wouldn't work as intended.

Our rule is:

```

Normal middleware
      ↓
Routes
      ↓
404 middleware
      ↓
Error middleware

```

***Remember this pattern. You'll see it constantly in real Express applications.***

---

### 6. Now request validation

Our future API will receive things like:

```

POST /incidents

```

with:

```
{
  "service": "payment-service",
  "severity": "critical"
}

```

What happens if someone sends:
```
{}
```

or:

```

{
  "service": 123
}

```


or:

```

{
  "severity": "something-random"
}

```

We shouldn't allow invalid data to enter our application.

---


### 7. Create a validation error

We already have:

```
ValidationError

```

from Lecture 3.

We'll use it now.

```

throw new ValidationError(
  "Service name is required",
  "SERVICE_NAME_REQUIRED"
);

```

---

### 8. Create a simple validation middleware

Create:

```
src/middleware/validation.middleware.ts
```

```
import { Request, Response, NextFunction } from "express";
import { ValidationError } from "../errors/ValidationError.js";

type Validator = (req: Request) => void;

export const validate = (validator: Validator) => {
  return (
    req: Request,
    _res: Response,
    next: NextFunction
  ) => {
    try {
      validator(req);
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        next(error);
        return;
      }

      next(error);
    }
  };
};

```

This gives us a reusable pattern:

```
Request
   ↓
validate(...)
   ↓
Controller
```

---

### 9. Create our first request schema

We don't need a validation library yet.

Create:

```

src/validators/incident.validator.ts

```

First create the directory:

```

mkdir src/validators

```

Then:

```
import { Request } from "express";
import { ValidationError } from "../errors/ValidationError.js";

export const validateCreateIncident = (
  req: Request
) => {
  const { service, severity } = req.body;

  if (
    typeof service !== "string" ||
    service.trim().length === 0
  ) {
    throw new ValidationError(
      "Service is required",
      "SERVICE_REQUIRED"
    );
  }

  const validSeverities = [
    "low",
    "medium",
    "high",
    "critical"
  ];

  if (!validSeverities.includes(severity)) {
    throw new ValidationError(
      "Invalid severity",
      "INVALID_SEVERITY"
    );
  }
};
```

---

### 10. Why are we writing this manually?

Because I want you to understand what a validation library is actually doing.

Eventually we can use something like:
```
Zod
```

But first understand the underlying mechanism:

```
Input
 ↓
Check type
 ↓
Check required fields
 ↓
Check allowed values
 ↓
Accept / Reject

```

Then a library becomes a productivity tool rather than magic.

---

### 11. Let's create an Incident endpoint

We're finally going to introduce the first domain concept.

Create:
```
src/controllers/incident.controller.ts

```

```
import { Request, Response } from "express";

export const createIncident = (
  req: Request,
  res: Response
) => {
  const { service, severity } = req.body;

  res.status(201).json({
    success: true,
    data: {
      service,
      severity
    }
  });
};
```

This isn't storing anything yet.

That's intentional.

##### PostgreSQL comes later.

Right now we're testing:

```
HTTP
+
Validation
+
Controller
+
Error architecture

```

---

### 12. Create Incident routes

Create:

```

src/routes/incident.routes.ts

```

```

import { Router } from "express";
import { createIncident } from "../controllers/incident.controller.js";
import { validate } from "../middleware/validation.middleware.js";
import { validateCreateIncident } from "../validators/incident.validator.js";

const router = Router();

router.post(
  "/",
  validate(validateCreateIncident),
  createIncident
);

export default router;

```

---

### 13. Register the route

In:
```
src/app.ts
```

add:

```

import incidentRoutes from "./routes/incident.routes.js";

```

Then:

```

app.use("/incidents", incidentRoutes);

```

So:
```

POST /incidents

```

flows through:

```

Request
   ↓
/incidents
   ↓
validate()
   ↓
validateCreateIncident()
   ↓
createIncident()

```

---

### 14. Valid request

Send:

```

POST /incidents
Content-Type: application/json

```

Body:

```

{
  "service": "payment-service",
  "severity": "critical"
}

```

Expected:

```

{
  "success": true,
  "data": {
    "service": "payment-service",
    "severity": "critical"
  }
}

```

---


### 15. Invalid request

Send:

```

{}

```

Expected:


```

{
  "success": false,
  "error": {
    "code": "SERVICE_REQUIRED",
    "message": "Service is required"
  }
}

```

HTTP status:

```

400

```

---

### 16. Invalid severity

Send:

```

{
  "service": "payment-service",
  "severity": "banana"
}

```

Expected:

```

{
  "success": false,
  "error": {
    "code": "INVALID_SEVERITY",
    "message": "Invalid severity"
  }
}

```

---

### 17. Write tests

Create:

```
tests/incidents.api.test.ts

```

```
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("POST /incidents", () => {
  it("should create an incident request", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        service: "payment-service",
        severity: "critical"
      });

    expect(response.status).toBe(201);

    expect(response.body).toEqual({
      success: true,
      data: {
        service: "payment-service",
        severity: "critical"
      }
    });
  });

  it("should reject missing service", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        severity: "critical"
      });

    expect(response.status).toBe(400);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "SERVICE_REQUIRED",
        message: "Service is required"
      }
    });
  });

  it("should reject invalid severity", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        service: "payment-service",
        severity: "banana"
      });

    expect(response.status).toBe(400);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INVALID_SEVERITY",
        message: "Invalid severity"
      }
    });
  });
});

```

Run:

```

npm run test:run

```

### Now intentionally break validation

Change:

```

"critical"


```

to:

```

"crit"

```

in your validator's allowed values.

Run:

```

npm run test:run

```

Your valid-incident test should fail.

That's exactly what we want.

Restore:
```

"critical"

```

and run again.

---


### 18 Current architecture

We've now reached:
```
src/
│
├── app.ts
├── server.ts
│
├── controllers/
│   ├── health.controller.ts
│   └── incident.controller.ts
│
├── routes/
│   ├── health.routes.ts
│   └── incident.routes.ts
│
├── validators/
│   └── incident.validator.ts
│
├── middleware/
│   ├── error.middleware.ts
│   ├── not-found.middleware.ts
│   └── validation.middleware.ts
│
└── errors/
    ├── AppError.ts
    ├── NotFoundError.ts
    └── ValidationError.ts
```

Request flow:

```
                   HTTP
                    │
                    ▼
                Express
                    │
                    ▼
                  Route
                    │
                    ▼
               Validation
                    │
              ┌─────┴─────┐
              │           │
           Invalid       Valid
              │           │
              ▼           ▼
          AppError    Controller
              │           │
              │           ▼
              │        Response
              │
              ▼
       Error Middleware
              │
              ▼
          JSON Error

```

