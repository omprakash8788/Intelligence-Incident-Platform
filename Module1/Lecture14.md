### Module 1 — Lecture 14
### Pagination & Filtering — Offset vs Cursor Pagination

Today we are going to build something every production backend needs:
```
GET /incidents
```
But instead of returning every incident, we'll support:
```
Pagination
Filtering
Sorting
Limits
```
And we'll learn the difference between:
```
OFFSET pagination
```
and:
```
Cursor / Keyset pagination
```
This is especially important for our platform because the incident table could eventually contain `millions of rows`.

---

### 1. The problem

Imagine we have:
```
10 million incidents
```
A bad API would do:
```
GET /incidents
```
and return:
```
10,000,000 rows
```
Problems:

- huge database work
- huge network response
- huge Node.js memory usage
- slow API
- slow frontend
- unnecessary data transfer

Instead:
```
Client
  ↓
GET /incidents?limit=20
  ↓
PostgreSQL
  ↓
20 rows
```

---

### 2. Our first pagination strategy — OFFSET

The simplest approach is:
```
SELECT *
FROM incidents
ORDER BY created_at DESC
LIMIT 20
OFFSET 0;
```
Page 1:
```
LIMIT 20
OFFSET 0
```
Page 2:
```
LIMIT 20
OFFSET 20
```
Page 3:
```
LIMIT 20
OFFSET 40
```
Formula:

```
OFFSET = (page - 1) × limit
```

---

### 3. Example

Suppose the database contains:
```
1
2
3
4
5
...
100
```
With:
```
LIMIT 10
OFFSET 0
```
we get:
```
1-10
```
Then:
```
LIMIT 10
OFFSET 10
```
we get:
```
11-20
```
Then:
```
LIMIT 10
OFFSET 20
```
we get:
```
21-30
```
Simple.

---

### 4. But OFFSET has a problem

Imagine:
```
10,000,000 rows
```
and we request:
```
LIMIT 20
OFFSET 9,999,980;
```
The database can't magically jump to the final 20 rows in the general case.

It may need to walk through a huge number of rows/index entries before producing the requested page.

Conceptually:

```
OFFSET 9,999,980

skip
 ↓
row 1
row 2
row 3
...
row 9,999,980
 ↓
return next 20
```
This becomes increasingly expensive as the offset grows.

---

### 5. First build the simple version

We want our API to eventually support:
```
GET /incidents?page=1&limit=20
```
and:
```
GET /incidents?service=payment-service
```
and:
```
GET /incidents?severity=critical
```
and combinations:
```
GET /incidents?service=payment-service&severity=critical&page=1&limit=20
```

---

### 6. Define our query type

Create:
```
src/domain/incident-query.ts
```
```
import type { IncidentSeverity, IncidentStatus } from "./incident.js";

export interface IncidentQuery {
  page: number;
  limit: number;
  service?: string;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
}
```
This gives us a strongly typed representation of the API query.

---

### 7. Validate query parameters

Create:
```
src/validators/incident-query.validator.ts
```
```
import type { Request } from "express";
import { ValidationError } from "../errors/ValidationError.js";

const validSeverities = [
  "low",
  "medium",
  "high",
  "critical"
] as const;

const validStatuses = [
  "detected",
  "investigating",
  "acknowledged",
  "mitigating",
  "resolved",
  "closed"
] as const;

export const validateIncidentQuery = (
  req: Request
) => {

  const page = Number(req.query.page ?? 1);

  const limit = Number(req.query.limit ?? 20);

  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError(
      "page must be a positive integer",
      "INVALID_PAGE"
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new ValidationError(
      "limit must be between 1 and 100",
      "INVALID_LIMIT"
    );
  }

  if (
    req.query.severity &&
    !validSeverities.includes(
      req.query.severity as any
    )
  ) {
    throw new ValidationError(
      "Invalid severity",
      "INVALID_SEVERITY"
    );
  }

  if (
    req.query.status &&
    !validStatuses.includes(
      req.query.status as any
    )
  ) {
    throw new ValidationError(
      "Invalid status",
      "INVALID_STATUS"
    );
  }
};
```
---

### 8. Why maximum limit?

We deliberately enforce:
```
limit <= 100
```
Without that, someone could request:
```
GET /incidents?limit=10000000
```
That is dangerous.

Even if PostgreSQL can handle the query, our application may have to serialize and transfer millions of rows.

Therefore:
```
Client
 ↓
limit = 10,000,000
 ↓
❌ API rejects request
```
This is an example of `resource protection`.

---

### 9. Repository query design

Now we need a repository method.

Open:
```
src/repositories/incident.repository.interface.ts
```
```
import type { Incident, IncidentSeverity, IncidentStatus } from "../domain/incident.js";
import type { PoolClient } from "pg";

export interface CreateIncidentData {
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
}

export interface IncidentQuery {
  page: number;
  limit: number;
  service?: string;
  severity?: IncidentSeverity;
  status?: IncidentStatus;
}

export interface IncidentRepositoryContract {

  create(
    data: CreateIncidentData
  ): Promise<Incident>;

  findById(
    id: string
  ): Promise<Incident | null>;

  createWithClient(
    client: PoolClient,
    data: CreateIncidentData
  ): Promise<Incident>;

  findMany(
    query: IncidentQuery
  ): Promise<Incident[]>;
}
```
---

### 10. Implement findMany

In:
```
src/repositories/incident.repository.ts
```
```
async findMany(
  query: IncidentQuery
): Promise<Incident[]> {

  const {
    page,
    limit,
    service,
    severity,
    status
  } = query;

  const conditions: string[] = [];
  const values: unknown[] = [];

  let parameterIndex = 1;

  if (service) {
    conditions.push(
      `service = $${parameterIndex}`
    );

    values.push(service);
    parameterIndex++;
  }

  if (severity) {
    conditions.push(
      `severity = $${parameterIndex}`
    );

    values.push(severity);
    parameterIndex++;
  }

  if (status) {
    conditions.push(
      `status = $${parameterIndex}`
    );

    values.push(status);
    parameterIndex++;
  }

  const offset = (page - 1) * limit;

  values.push(limit);
  const limitParameter = parameterIndex++;

  values.push(offset);
  const offsetParameter = parameterIndex++;

  const whereClause =
    conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

  const sql = `
    SELECT
      id,
      service,
      severity,
      status,
      created_at,
      updated_at,
      acknowledged_at
    FROM incidents
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitParameter}
    OFFSET $${offsetParameter}
  `;

  const result = await pool.query(
    sql,
    values
  );

  return result.rows.map((row) => ({
    id: row.id,
    service: row.service,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at
  }));
}
```
There is an important detail here.

---

### 11. Why ORDER BY created_at, id?

You might initially write:
```
ORDER BY created_at DESC
```
But two incidents can have exactly the same timestamp.

For deterministic ordering we use:
```
ORDER BY
    created_at DESC,
    id DESC
```
This gives us:
```
created_at
    ↓
primary ordering

id
    ↓
tie breaker
```
This becomes `extremely important for cursor pagination` later.

---

### 12. Update the domain type

Because we added:
```
acknowledged_at
```
during Lecture 11, our domain should eventually represent it.

Update:
```
src/domain/incident.ts
```
to:
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
  acknowledgedAt: Date | null;
}
```
Now TypeScript knows that an incident may or may not have been acknowledged.

---

### 13. Service method

Open:
```
src/services/incident.service.ts
```
Add:
```
import type { IncidentQuery } from "../domain/incident-query.js";
```
Then:
```
async getIncidents(
  query: IncidentQuery
): Promise<Incident[]> {

  return this.incidentRepository.findMany(
    query
  );
}
```
Very simple.

The service doesn't know SQL.
That's intentional.

---

### 14. Controller

Add:

```
export const getIncidents = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    const page = Number(
      req.query.page ?? 1
    );

    const limit = Number(
      req.query.limit ?? 20
    );

    const incidents =
      await incidentService.getIncidents({
        page,
        limit,
        service:
          typeof req.query.service === "string"
            ? req.query.service
            : undefined,
        severity:
          typeof req.query.severity === "string"
            ? req.query.severity as any
            : undefined,
        status:
          typeof req.query.status === "string"
            ? req.query.status as any
            : undefined
      });

    res.status(200).json({
      success: true,
      data: incidents
    });

  } catch (error) {
    next(error);
  }
};
```
We will improve the typing and response contract later.

For now, focus on understanding the flow.

---

### 15. Route

Update:
```
src/routes/incident.routes.ts
```
Add:
```
import {
  createIncident,
  getIncidentById,
  getIncidents
} from "../controllers/incident.controller.js";
```
Then:
```
router.get(
  "/",
  validate(validateIncidentQuery),
  getIncidents
);
```
Now:
```
GET /incidents
```
will execute our list query.

---

### 16. Test it

Start the server:
```
npm run dev
```
Then open:
```
http://localhost:3000/incidents
```
You should get something like:
```
{
  "success": true,
  "data": [
    {
      "id": "...",
      "service": "payment-service",
      "severity": "critical",
      "status": "detected"
    }
  ]
}
```

---

### 17. Test pagination

Try:
```
GET /incidents?page=1&limit=5
```
Then:
```
GET /incidents?page=2&limit=5
```
You should receive different sets of records.

---

### 18. Test filtering

Try:
```
GET /incidents?service=payment-service
```
Then:
```
GET /incidents?severity=critical
```
Then:
```
GET /incidents?status=investigating
```
And combinations:
```
GET /incidents?service=payment-service&severity=critical
```

---

### 19. Test invalid input

Try:
```
GET /incidents?limit=1000
```
Expected:
```
{
  "success": false,
  "error": {
    "code": "INVALID_LIMIT",
    "message": "limit must be between 1 and 100"
  }
}
```
Try:
```
GET /incidents?page=0
```
Should fail.

Try:
```
GET /incidents?severity=banana
```
Should fail.

This is why we validate query parameters `before reaching the repository`.

---

### 20. Now the important problem: OFFSET performance

Let's generate enough data.

You already generated approximately:
```
100,000 incidents
```
Run:
```
SELECT COUNT(*)
FROM incidents;
```
Now:
```
EXPLAIN ANALYZE
SELECT
    id,
    service,
    severity,
    status,
    created_at
FROM incidents
ORDER BY created_at DESC, id DESC
LIMIT 20
OFFSET 0;
```
Then:
```
EXPLAIN ANALYZE
SELECT
    id,
    service,
    severity,
    status,
    created_at
FROM incidents
ORDER BY created_at DESC, id DESC
LIMIT 20
OFFSET 90000;
```
Compare the execution information.

The large offset requires PostgreSQL to process more rows before returning the requested page.

---

### 21. The deeper problem: data can change

There is another problem with OFFSET pagination.

Imagine page 1 contains:
```
A
B
C
D
E
```
Then a new incident arrives:
```
X
```

because we're sorting newest first:
```
X
A
B
C
D
E
```
Now the client asks for page 2.

Using:
```
OFFSET 5
```
the result may shift.

The client can potentially:

- see duplicates
- miss records
- experience inconsistent pages

This is called `pagination instability`.

For a constantly changing incident platform, that's important.

---

### 22. Cursor pagination

Instead of saying:

`"Skip the first 50,000 rows."`

we say:

`"Give me records after this specific record."`

Example:
```
last record:
created_at = 2026-09-26 10:30:00
id = abc123
```
Next query:
```
WHERE
    (
        created_at < $1
        OR (
            created_at = $1
            AND id < $2
        )
    )
ORDER BY
    created_at DESC,
    id DESC
LIMIT 20;
```
Now PostgreSQL has a precise boundary.

---

### 23. Why the OR condition?

Our ordering is:
```
ORDER BY
    created_at DESC,
    id DESC
```
Suppose the cursor is:
```
created_at = T
id = ABC
```
For the next page we want records that come `after` that record in descending order.

Therefore:
```
created_at < T
```
OR:
```
created_at = T
AND id < ABC
```
This handles ties correctly.

---

### 24. Visualizing cursor pagination

Imagine:
```
created_at          id
------------------------
10:00               Z
09:59               X
09:59               W
09:58               B
09:57               A
```
We return:
```
10:00 Z
09:59 X
```
Cursor becomes:
```
09:59 X
```
Next query asks:

```
created_at < 09:59

OR

created_at = 09:59
AND id < X
```
Result:
```
09:59 W
09:58 B
```
No need for:
```
OFFSET 2
```
---

### 25. Cursor pagination is not automatically magic

It requires a good ordering strategy.

We need:
```
stable ordering
+
appropriate index
+
unique tie-breaker
```
That's why we deliberately chose:
```
ORDER BY created_at DESC, id DESC
```
instead of just:
```
ORDER BY created_at DESC
```
This design decision will pay off later.

---

### 26. Composite index for cursor pagination

Eventually, we want an index like:
```
CREATE INDEX idx_incidents_created_at_id
ON incidents(created_at DESC, id DESC);
```
This supports our ordering pattern.

But don't blindly create it yet.

We will formally design this in the next lecture after understanding composite indexes and query patterns.

---

### 27. OFFSET vs Cursor

| Feature                    | OFFSET               | Cursor                |
| -------------------------- | -------------------- | --------------------- |
| Simple to implement        | ✅                    | More complex          |
| Easy page numbers          | ✅                    | ❌                     |
| Deep pagination            | Can become expensive | Better suited         |
| Stable with changing data  | Weaker               | Better                |
| Good for small admin lists | ✅                    | Sometimes unnecessary |
| Good for huge datasets     | Often problematic    | Usually better        |
| Requires stable cursor     | ❌                    | ✅                     |


Neither is universally "correct."

For our platform:
```
Small internal admin screen
        ↓
OFFSET can be perfectly fine

Large/high-volume incident feed
        ↓
Cursor pagination is a strong candidate
```

---

### 28. One important production lesson

Don't prematurely replace every OFFSET query with cursor pagination.

If we have:
```
500 records
```
and:
```
page=3
```
OFFSET is perfectly reasonable.

If we have:
```
100 million records
```
and clients continuously scroll through recent incidents:
```
Cursor pagination
```
becomes much more attractive.

Architecture should follow workload.

---

### 29. Our API contract should eventually look like this

Instead of returning only:
```
{
  "success": true,
  "data": [...]
}
```
we'll eventually return metadata:
```
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "hasNextPage": true
  }
}
```
For cursor pagination:
```
{
  "success": true,
  "data": [],
  "pagination": {
    "nextCursor": "..."
  }
}
```
We'll formally design this response contract in `Lecture 15`.

---

### 30. Important security/performance rule

Never build SQL like this:
```
const sql = `
  SELECT *
  FROM incidents
  WHERE service = '${service}'
`;
```
That is dangerous.

We use:
```
conditions.push(
  `service = $${parameterIndex}`
);

values.push(service);
```
Then:

```
pool.query(sql, values);
```
So the actual query becomes parameterized:
```
WHERE service = $1
```
This protects against SQL injection and gives PostgreSQL properly typed parameter values.

---

### 31. Lecture 14 checkpoint

Before moving forward, run these.

#### API
```
GET /incidents
```
#### Pagination
```
GET /incidents?page=1&limit=10
```
```
GET /incidents?page=2&limit=10
```
#### Filtering
```
GET /incidents?service=payment-service
```
```
GET /incidents?severity=critical
```
```
GET /incidents?status=investigating
```
#### Combined
```
GET /incidents?service=payment-service&severity=critical&limit=10
```
#### Invalid
```
GET /incidents?limit=1000
```
#### PostgreSQL performance

Run:
```
EXPLAIN ANALYZE
SELECT *
FROM incidents
ORDER BY created_at DESC, id DESC
LIMIT 20
OFFSET 0;
```
Then:
```
EXPLAIN ANALYZE
SELECT *
FROM incidents
ORDER BY created_at DESC, id DESC
LIMIT 20
OFFSET 90000;
```
Compare the plans.

Finally:
```
npm run build
```
and:
```
npm run test:run
```

---