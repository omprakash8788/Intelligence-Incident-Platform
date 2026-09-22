### Lecture 8 — Repository Layer + First Real PostgreSQL Write

This is an important lecture.

Until now:

```
POST /incidents
        ↓
Validation
        ↓
Controller
        ↓
Response
```

The incident ***wasn't actually stored.***

Today we'll change that:

```
POST /incidents
        ↓
Validation
        ↓
Controller
        ↓
Service
        ↓
Repository
        ↓
PostgreSQL
        ↓
201 Created
```

We'll also learn an important architectural boundary:

 ### Controllers should not contain SQL.

---

### 1. Our target architecture

By the end of this lecture:

```
                    HTTP
                     │
                     ▼
                  Router
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
              PostgreSQL Pool
                     │
                     ▼
                 incidents
```

Each layer has a responsibility.

| Layer      | Responsibility        |
| ---------- | --------------------- |
| Route      | HTTP routing          |
| Validation | Validate input        |
| Controller | HTTP request/response |
| Service    | Business rules        |
| Repository | Database operations   |
| PostgreSQL | Persistent storage    |


---

### 2. First: define the Incident domain

Create:
```
src/domain/
```

Then:
```
src/domain/incident.ts
```

Add:
```
export type IncidentSeverity =
  | "low"
  | "medium"
  | "high"
  | "critical";

export type IncidentStatus =
  | "detected"
  | "investigating"
  | "acknowledged"
  | "mitigating"
  | "resolved"
  | "closed";

export interface Incident {
  id: string;
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  createdAt: Date;
  updatedAt: Date;
}

```

---

### 3. Why create domain types?

Previously we had strings everywhere:
```
severity: string
```

That allows:
```
banana
hello
critical123
xyz
```

But our domain says severity can only be:
```
low
medium
high
critical
```

So TypeScript can protect us:
```
const severity: IncidentSeverity = "critical";
```

Valid.

But:
```
const severity: IncidentSeverity = "banana";
```

TypeScript rejects it.

---

### 4. Create the repository

Create:
```
src/repositories/
```
Then:
```
src/repositories/incident.repository.ts
```
We'll start with one operation:
```
createIncident()
```

Code:

```
import { pool } from "../database/pool.js";
import type {
  Incident,
  IncidentSeverity,
  IncidentStatus
} from "../domain/incident.js";

interface CreateIncidentData {
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
}

export class IncidentRepository {
  async create(
    data: CreateIncidentData
  ): Promise<Incident> {
    const query = `
      INSERT INTO incidents (
        id,
        service,
        severity,
        status
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3
      )
      RETURNING
        id,
        service,
        severity,
        status,
        created_at,
        updated_at
    `;

    const result = await pool.query(query, [
      data.service,
      data.severity,
      data.status
    ]);

    const row = result.rows[0];

    return {
      id: row.id,
      service: row.service,
      severity: row.severity,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
```

---

### 5. Stop here and understand $1, $2, $3

We are not doing this:

```
const query = `
  INSERT INTO incidents (...)
  VALUES ('${service}', '${severity}', '${status}')
`;
```

That's dangerous.

Instead:

```

VALUES ($1, $2, $3)

```

and:

```
[
  data.service,
  data.severity,
  data.status
]

```

PostgreSQL's driver binds the parameters.

This is called a ***parameterized query.***

It helps prevent SQL injection and keeps query construction separate from data.

---


### 6. Why RETURNING?

Our SQL says:

```
RETURNING
  id,
  service,
  severity,
  status,
  created_at,
  updated_at
```

Instead of:

```
INSERT
  ↓
INSERT succeeds
  ↓
SELECT again

```

we can get the newly created record from the same SQL statement.

So:

```

INSERT
  +
RETURNING
```


gives us the database-generated values.

Particularly:
```
id
created_at
updated_at
```

---

### 7. PostgreSQL UUID generation

Our query uses:

```
gen_random_uuid()

```

This function is available in modern PostgreSQL installations.

Let's verify it.

Open PostgreSQL:

```

docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence

```

Run:
```
SELECT gen_random_uuid();  [Note - direct run in pg admin]

```

You should get something like:
```
550e8400-e29b-41d4-a716-446655440000
```

Exit:
```
\q
```
---

### 8. Create the Service layer

Create:
```
src/services/
```

Then:
```
src/services/incident.service.ts
```

```
import { IncidentRepository } from "../repositories/incident.repository.js";
import type {
  Incident,
  IncidentSeverity
} from "../domain/incident.js";

interface CreateIncidentInput {
  service: string;
  severity: IncidentSeverity;
}

export class IncidentService {
  constructor(
    private readonly incidentRepository: IncidentRepository
  ) {}

  async createIncident(
    input: CreateIncidentInput
  ): Promise<Incident> {
    const incident =
      await this.incidentRepository.create({
        service: input.service,
        severity: input.severity,
        status: "detected"
      });

    return incident;
  }
}
```

---

### 9. Why do we need a Service?

You might ask:

Why not Controller → Repository?

Because business logic belongs somewhere.

For example:

```

When incident is created:
    status = detected

```

That's a business rule.

The controller shouldn't decide that.

We want:

```

Controller
    ↓
Service
    ↓
Repository

```

The service understands the business.

The repository understands the database.


---

### 10. Create the Controller properly

Replace:
```
src/controllers/incident.controller.ts
```
with:

```
import { Request, Response, NextFunction } from "express";
import { IncidentRepository } from "../repositories/incident.repository.js";
import { IncidentService } from "../services/incident.service.js";

const incidentRepository =
  new IncidentRepository();

const incidentService =
  new IncidentService(incidentRepository);

export const createIncident = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const incident =
      await incidentService.createIncident({
        service: req.body.service,
        severity: req.body.severity
      });

    res.status(201).json({
      success: true,
      data: incident
    });
  } catch (error) {
    next(error);
  }
};
```

---

### 11. Our complete request flow

Now:

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

goes through:

```
HTTP
 │
 ▼
incident.routes.ts
 │
 ▼
validateCreateIncident()
 │
 ▼
createIncident()
 │
 ▼
IncidentService
 │
 ▼
IncidentRepository
 │
 ▼
PostgreSQL
 │
 ▼
INSERT
 │
 ▼
RETURNING
 │
 ▼
Incident
 │
 ▼
JSON Response
```

This is the first proper vertical slice of our application.

---

### 12. Run the application

Make sure PostgreSQL is running:
```
docker compose up -d postgres

```

Start Node:

```
npm run dev

```

---

### 13. Create your first real incident

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

Expected response:

```
{
  "success": true,
  "data": {
    "id": "some-uuid",
    "service": "payment-service",
    "severity": "critical",
    "status": "detected",
    "createdAt": "2026-09-22T...",
    "updatedAt": "2026-09-22T..."
  }
}

```

The exact UUID and timestamps will obviously differ.

---

### 14. Verify directly in PostgreSQL

Open:

```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence

```

### Note VVI - Direct run query in pg admin - Don't run above docker code in terminal.

Run:

```

SELECT
    id,
    service,
    severity,
    status,
    created_at,
    updated_at
FROM incidents;

```

You should see the incident you created.

***This is important.***

We've now proven:

```
HTTP request
      ↓
Node.js
      ↓
Service
      ↓
Repository
      ↓
PostgreSQL

```

actually works.

---


### 15. Test persistence

Now stop your Node server.

Start it again:

```
npm run dev
```

Query PostgreSQL:

```

SELECT * FROM incidents;

```

The incident should still exist.

That's the difference between:

```
In-memory application

```

and:

```
Persistent application

```

---


### 16. Add a repository method: `findById`

Now let's make our repository useful.

Add to:

```

src/repositories/incident.repository.ts

```

```
async findById(
  id: string
): Promise<Incident | null> {
  const query = `
    SELECT
      id,
      service,
      severity,
      status,
      created_at,
      updated_at
    FROM incidents
    WHERE id = $1
  `;

  const result = await pool.query(query, [id]);

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    id: row.id,
    service: row.service,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
```

Now our repository supports:

```
create()
findById()
```

---

Now our repository supports:
```
create()
findById()

```

---

### 17. Add service method

In:
```
src/services/incident.service.ts
```
add:
```
import { NotFoundError } from "../errors/NotFoundError.js";
```
Then:
```
async getIncidentById(
  id: string
): Promise<Incident> {
  const incident =
    await this.incidentRepository.findById(id);

  if (!incident) {
    throw new NotFoundError(
      "Incident not found",
      "INCIDENT_NOT_FOUND"
    );
  }

  return incident;
}
```

Notice where the NotFoundError happens.

Not repository.

Not controller.

### Service.

Why?

Because:

```
Repository:
"Database has no row."

Service:
"That means the requested incident doesn't exist."

```

That's a business/application interpretation.

---

### 18. Add GET controller

In:
```
src/controllers/incident.controller.ts
```

add:
```
export const getIncidentById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const incident =
      await incidentService.getIncidentById(
        req.params.id
      );

    res.status(200).json({
      success: true,
      data: incident
    });
  } catch (error) {
    next(error);
  }
};

```

---

### 19. Add route

In:
```
src/routes/incident.routes.ts
```
add:
```
router.get("/:id", getIncidentById);
```

Your file should now roughly look like:

```
import { Router } from "express";
import {
  createIncident,
  getIncidentById
} from "../controllers/incident.controller.js";
import { validate } from "../middleware/validation.middleware.js";
import { validateCreateIncident } from "../validators/incident.validator.js";

const router = Router();

router.post(
  "/",
  validate(validateCreateIncident),
  createIncident
);

router.get("/:id", getIncidentById);

export default router;
```

---

### 20. Test GET

Suppose your created incident has:

```
id = 550e8400-e29b-41d4-a716-446655440000
```

Call:

```
GET /incidents/550e8400-e29b-41d4-a716-446655440000

```

Expected:

```
{
  "success": true,
  "data": {
    "id": "...",
    "service": "payment-service",
    "severity": "critical",
    "status": "detected",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

---

### 21. Test a nonexistent incident

Call:

```

GET /incidents/00000000-0000-0000-0000-000000000000
```

Expected:

```
404
```

Response:


```
{
  "success": false,
  "error": {
    "code": "INCIDENT_NOT_FOUND",
    "message": "Incident not found"
  }
}

```

Our flow is:

```
Repository
   ↓
null
   ↓
Service
   ↓
NotFoundError
   ↓
Global Error Middleware
   ↓
404

```

This is exactly the separation we wanted.

---

### 22. Now write the integration tests

Create/update:

```
tests/incidents.api.test.ts
```

For now, the tests that actually write to PostgreSQL should be treated as integration tests.

Example:

```
import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("Incident API", () => {
  it("should create an incident", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        service: "payment-service",
        severity: "critical"
      });

    expect(response.status).toBe(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.service)
      .toBe("payment-service");

    expect(response.body.data.severity)
      .toBe("critical");

    expect(response.body.data.status)
      .toBe("detected");

    expect(response.body.data.id)
      .toBeDefined();
  });

  it("should return 404 for missing incident", async () => {
    const response = await request(app)
      .get(
        "/incidents/00000000-0000-0000-0000-000000000000"
      );

    expect(response.status).toBe(404);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INCIDENT_NOT_FOUND",
        message: "Incident not found"
      }
    });
  });
});
```

---

### 23. Important problem with our tests

Run:

```
npm run test:run

```

You may discover something interesting.

Our previous:

```

health.controller.test.ts

```

may now fail because the controller tries to connect to PostgreSQL.

That's not necessarily a production bug.

It's a ***testing architecture problem.***

We changed:
```
Health Controller
```

from:
```
pure HTTP logic
```

to:
```
HTTP + database dependency
```

This is precisely why dependency boundaries matter.

We'll solve this properly in the next lecture.

---

### 24. One more important database concept

Look at our SQL:

```
INSERT INTO incidents (
    id,
    service,
    severity,
    status
)
VALUES (
    gen_random_uuid(),
    $1,
    $2,
    $3
)
RETURNING ...

```

The database is responsible for:

```
UUID generation
timestamps
persistence

```

while the application is responsible for:

```
service name
severity
business rules
status initialization

```

That's a healthy separation.

---

### 25. Current architecture

We now have:

```
                         CLIENT
                            │
                            ▼
                       Express API
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
       POST /incidents               GET /incidents/:id
             │                             │
             ▼                             ▼
        Validation                    Controller
             │                             │
             ▼                             ▼
        Controller                    Service
             │                             │
             └──────────────┬──────────────┘
                            ▼
                         Service
                            │
                            ▼
                       Repository
                            │
                            ▼
                     PostgreSQL Pool
                            │
                            ▼
                       PostgreSQL
                            │
                            ▼
                        incidents
```

---





