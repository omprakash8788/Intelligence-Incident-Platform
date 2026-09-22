### Module 1 — Foundation

### Lecture 2 — Production-Grade Application Structure

In Lecture 1, we created a working Express server.

Now we're going to fix the first architectural problem:

 - Our `app.ts` is doing too much.


Currently:
```
app.ts
 ├── create Express app
 ├── middleware
 ├── routes
 ├── business logic
 └── server startup
```

That becomes difficult to maintain as our platform grows.

We want:

```
src/
├── app.ts
├── server.ts
│
├── config/
├── routes/
├── controllers/
├── services/
├── repositories/
├── middleware/
├── domain/
├── events/
├── queues/
└── workers/

```

But `we won't create empty folders just for the sake of architecture`. We'll introduce each layer when we actually need it.

---

### 1. Separate app from server

This is an important production pattern.

`app.ts`

The application should configure Express.

```
import express from "express";

const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "production-intelligence-platform"
  });
});

export default app;
```

Notice:

`No `app.listen() `here.`

---

### 2. Create server.ts

Create:
```
src/server.ts
```
```
import app from "./app.js";

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

```

Now 
```
app.ts
   ↓
Express configuration

server.ts
   ↓
Starts HTTP server
```

---

### 3. Why separate them?

This becomes extremely important when testing.

Later we can do:
```
import app from "../src/app.js";
```

### Note - Update this part
```
 "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },

    "type": "module",
```

and test:

```
http://localhost:3000/health

```

So:
```
Production

server.ts
    ↓
  app.ts

```

while testing:

```
test
  ↓
app.ts
```

This is one reason production applications separate application creation from server startup.

---

### 4. Create routes

Right now this exists inside app.ts:

```
app.get("/health", ...)
```

Let's move it.

Create:

```
src/routes/health.routes.ts
```

```
import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "production-intelligence-platform"
  });
});

export default router;
```

Then modify `app.ts:`

```
import express from "express";
import healthRoutes from "./routes/health.routes.js";

const app = express();

app.use(express.json());

app.use("/health", healthRoutes);

export default app;
```

Now our request flow is:

```
GET /health
      ↓
    app.ts
      ↓
/health router
      ↓
health.routes.ts
      ↓
   response
```

---

### 5. Why use Router?

Imagine we eventually have:

```
/api
├── /health
├── /incidents
├── /services
├── /metrics
├── /events
├── /queues
└── /workers

```


We don't want:

```
app.ts

500 lines
1000 lines
2000 lines

```

Instead:

```
routes/
├── health.routes.ts
├── incident.routes.ts
├── service.routes.ts
├── metric.routes.ts
├── event.routes.ts
├── queue.routes.ts
└── worker.routes.ts
```

Each route module has a clear responsibility.

---

### 6. Introduce Controllers

There's another problem.

Our route currently contains response logic:

```
router.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok"
  });
});
```

For a tiny endpoint that's fine.

But imagine:
```
POST /incidents
```

Eventually it might need:

```
validate request
      ↓
create incident
      ↓
database
      ↓
publish event
      ↓
queue job
      ↓
return response
```

We don't want all of that inside the route.

So we'll introduce:

```
Controller
```

Create:
```
src/controllers/health.controller.ts
```
```
import { Request, Response } from "express";

export const healthController = (
  _req: Request,
  res: Response
) => {
  res.status(200).json({
    status: "ok",
    service: "production-intelligence-platform"
  });
};
```

Then modify:

```
src/routes/health.routes.ts
```

```
import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";

const router = Router();

router.get("/", healthController);

export default router;
```

Now:

```
HTTP Request
     ↓
   Router
     ↓
 Controller
     ↓
 Response
```

---

### 7. The architecture we have now

```
                 HTTP Request
                      │
                      ▼
                 Express App
                      │
                      ▼
                    Router
                      │
                      ▼
                 Controller
                      │
                      ▼
                  Response
```

Later:

```
HTTP Request
      │
      ▼
   Router
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

And for asynchronous work:

```
Controller
    │
    ▼
Service
    │
    ▼
BullMQ
    │
    ▼
Worker
    │
    ▼
Repository
    │
    ▼
PostgreSQL
```


### 8. Update package scripts

Because `server.ts` is now our entry point:

```
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  }
}
```

Run:
```
npm run dev
```

Then:
```
GET http://localhost:3000/health
```

Expected:
```
{
  "status": "ok",
  "service": "production-intelligence-platform"
}
```
---
### Lecture 2 Testing

Before moving on, test these.

Test 1 — Health
```
GET /health
```
Expected:
```
200
```

---

### Understand this before continuing

The important lesson isn't the folder structure.

It's the separation of responsibilities:

```
app.ts
→ configure application

server.ts
→ start application

routes
→ decide which endpoint handles request

controller
→ handle HTTP request/response

service
→ business logic

repository
→ database interaction

worker
→ asynchronous processing
```

Eventually our platform will have something much more interesting:

```
                 ┌──────────────┐
                 │ React Client │
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │ API Gateway  │
                 └──────┬───────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
        Synchronous          Asynchronous
          Request                Jobs
              │                   │
              ▼                   ▼
         Controller            BullMQ
              │                   │
              ▼                   ▼
          Service              Worker
              │                   │
              └─────────┬─────────┘
                        ▼
                   PostgreSQL

```

That's the architecture we're gradually building toward.

---


