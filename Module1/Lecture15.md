### Module 1 — Lecture 15
### API Response Contracts

We now have working pagination and filtering, but our API responses are not yet standardized.

A production backend should have a predictable contract.

Today we'll establish:
```
Success response
Error response
List response
Pagination metadata
TypeScript response types
Automated API tests
```
And we will `build → test → break → fix` before moving on.

---

### 1. Why response contracts matter

Currently one endpoint might return:
```
{
  "success": true,
  "data": {}
}
```
Another might return:
```
{
  "status": "ok"
}
```
Another:
```
{
  "error": "Something failed"
}
```
This makes frontend code unnecessarily complicated.
Instead, our API should have predictable shapes.

---

### 2. Our API contract

We'll establish two fundamental formats.

#### Success
```
{
  "success": true,
  "data": {}
}
```
#### Error
```
{
  "success": false,
  "error": {
    "code": "INCIDENT_NOT_FOUND",
    "message": "Incident not found"
  }
}
```

For lists:
```
{
  "success": true,
  "data": [],
  "meta": {}
}
```

---

### 3. Create API response types

Create:
```
src/types/api-response.ts
```

```
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiListResponse<T> {
  success: true;
  data: T[];
  meta: {
    page: number;
    limit: number;
    hasNextPage: boolean;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}
```
Now our response structure is represented in TypeScript.

---

### 4. Why generics?

Look at:
```
ApiSuccessResponse<T>
```
T can be anything.

For an incident:
```
ApiSuccessResponse<Incident>
```
For a user:
```
ApiSuccessResponse<User>
```
For an event:
```
ApiSuccessResponse<IncidentEvent>
```
The response structure remains the same.

---

### 5. List response

Our list response is:
```
ApiListResponse<Incident>
```
which becomes conceptually:
```
{
  "success": true,
  "data": [
    {}
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "hasNextPage": true
  }
}
```
This is much better than returning only:
```
{
  "success": true,
  "data": []
}
```
because the client needs to know whether another page exists.

---

### 6. The repository needs one more piece of information

Currently:
```
findMany()
```
returns only:
```
Promise<Incident[]>
```
But how do we know:
```
Is there another page?
```
We could run:
```
SELECT COUNT(*)
```
but that's potentially expensive on a large table.

A simple technique is:
```
Request one extra row.
```
If the client asks for:
```
limit = 20
```
we query:
```
LIMIT 21
```
Then:
```
21 rows returned
    ↓
hasNextPage = true
    ↓
return only first 20
```
If:
```
20 rows returned
```
then:
```
hasNextPage = false
```
This avoids a separate COUNT(*) query for every request.

---

### 7. Create pagination result type

Create:
```
src/domain/pagination.ts
```
```
export interface PaginatedResult<T> {
  items: T[];
  hasNextPage: boolean;
}
```
Now the repository can return:
```
PaginatedResult<Incident>
```

---

### 8. Update repository interface

Open:
```
src/repositories/incident.repository.interface.ts
```
Import:
```
import type { PaginatedResult } from "../domain/pagination.js";
```
Then change:
```
findMany(
  query: IncidentQuery
): Promise<PaginatedResult<Incident>>;
```

---

### 9. Update repository implementation

Modify findMany().

The important change is:
```
const queryLimit = limit + 1;
```
Then SQL:
```
values.push(queryLimit);
```
instead of:
```
values.push(limit);
```
After fetching:
```
const hasNextPage =
  result.rows.length > limit;

const rows =
  result.rows.slice(0, limit);

```
Then return:
```
return {
  items: rows.map((row) => ({
    id: row.id,
    service: row.service,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at
  })),
  hasNextPage
};
```
So the repository now gives us:
```
items
hasNextPage
```

---

### 10. Why LIMIT + 1?

Suppose:
```
limit = 5
```
We ask PostgreSQL for:
```
LIMIT 6
```
#### Case A

Database returns:
```
1
2
3
4
5
6
```
We know:
```
hasNextPage = true
```
Return:
```
1
2
3
4
5
```
#### Case B

Database returns:
```
1
2
3
4
```
We know:
```
hasNextPage = false
```
This is a simple and efficient technique.

---

### 11. Update service

In:
```
src/services/incident.service.ts
```
Change:
```
async getIncidents(
  query: IncidentQuery
)
```
to return:
```
Promise<PaginatedResult<Incident>>
```
Implementation:
```
async getIncidents(
  query: IncidentQuery
): Promise<PaginatedResult<Incident>> {

  return this.incidentRepository.findMany(
    query
  );
}
```
Import:
```
import type { PaginatedResult } from "../domain/pagination.js";
```
---

### 12. Update controller

`src/controllers/incident.controller.ts`

Our controller currently returns:

```
res.status(200).json({
  success: true,
  data: incidents
});
```
Change it to:

```
const result =
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
  data: result.items,
  meta: {
    page,
    limit,
    hasNextPage: result.hasNextPage
  }
});
```

---

### 13. Test the API

Run:
```
npm run dev
```
Then:
```
GET /incidents?limit=5
```
Expected shape:

```
{
  "success": true,
  "data": [
    {},
    {},
    {},
    {},
    {}
  ],
  "meta": {
    "page": 1,
    "limit": 5,
    "hasNextPage": true
  }
}
```
---

### 14. Test final page

Use a very large page number or a small dataset.

For example:
```
GET /incidents?page=100000&limit=20
```
Eventually you should get:
```
{
  "success": true,
  "data": [],
  "meta": {
    "page": 100000,
    "limit": 20,
    "hasNextPage": false
  }
}
```
We'll improve the behavior for empty pages later.

---

### 15. Standardize error responses

We already have:
```
errorMiddleware
```
and it returns:
```
{
  "success": false,
  "error": {
    "code": "...",
    "message": "..."
  }
}
```
That's good.

Let's formally type it.

Open:
```
src/middleware/error.middleware.ts
```

Import:
```
import type { ApiErrorResponse } from "../types/api-response.js";
```
Then:
```
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
```
This prevents accidentally changing the API structure.

---

### 16. Standardize success responses

We can also create helper functions.

Create:
```
src/utils/api-response.ts
```
```
import type { Response } from "express";

export const sendSuccess = <T>(
  res: Response,
  statusCode: number,
  data: T
) => {
  return res.status(statusCode).json({
    success: true,
    data
  });
};
```
Then the controller can do:
```
return sendSuccess(
  res,
  200,
  incident
);
```

---

### 17. List response helper

Add:

`add inside utils/api-response.ts`

```
utils/api-response.ts
```

### 

```
export const sendListSuccess = <T>(
  res: Response,
  data: T[],
  meta: {
    page: number;
    limit: number;
    hasNextPage: boolean;
  }
) => {
  return res.status(200).json({
    success: true,
    data,
    meta
  });
};
```
Then:


### Add below code inside 

`controllers/incident-controller.ts`

##### Write inside `export const getIncidents` Function

```
return sendListSuccess(
  res,
  result.items,
  {
    page,
    limit,
    hasNextPage: result.hasNextPage
  }
);
```

After Adding res look like this 

```
 return sendListSuccess(
      res,
      incidents.items,
      {
        page,
        limit,
        hasNextPage: incidents.hasNextPage
      }
    );
    
```


Now response formatting is centralized.

---

### 18. Why helpers?

Imagine six months from now we have:
```
Incident API
Alert API
Service API
Deployment API
Event API
User API
```
Without helpers:
```
Controller 1 → custom response
Controller 2 → slightly different response
Controller 3 → forgot success field
Controller 4 → different pagination metadata
```
With helpers:
```
Controllers
     ↓
Response utilities
     ↓
Consistent API contract
```

---

### 19. Don't over-abstract

There's an important lesson here.

We `should not` create:
```
BaseController
AbstractController
UniversalControllerFactory
GenericEnterpriseResponseBuilder
```
just because we can.

Our abstraction is simple:
```
sendSuccess()
sendListSuccess()
```
Good architecture is not about having the most abstractions.

It's about having the `right abstractions`.

---

### 20. API tests

Now update:
```
tests/incidents.api.test.ts
```
Add:

```
it("should list incidents", async () => {

  const response =
    await request(app)
      .get("/incidents")
      .query({
        page: 1,
        limit: 5
      });

  expect(response.status)
    .toBe(200);

  expect(response.body.success)
    .toBe(true);

  expect(
    Array.isArray(response.body.data)
  ).toBe(true);

  expect(response.body.meta)
    .toEqual(
      expect.objectContaining({
        page: 1,
        limit: 5
      })
    );
});
```
---

### 21. Test filtering

Add:

```
it("should filter incidents by service", async () => {

  const response =
    await request(app)
      .get("/incidents")
      .query({
        service: "payment-service",
        limit: 10
      });

  expect(response.status)
    .toBe(200);

  expect(response.body.success)
    .toBe(true);

  for (
    const incident
    of response.body.data
  ) {
    expect(incident.service)
      .toBe("payment-service");
  }
});
```
This is a real integration/API test.

---

### 22. Test invalid limit

Add:

```
it("should reject an invalid limit", async () => {

  const response =
    await request(app)
      .get("/incidents")
      .query({
        limit: 101
      });

  expect(response.status)
    .toBe(400);

  expect(response.body)
    .toEqual({
      success: false,
      error: {
        code: "INVALID_LIMIT",
        message:
          "limit must be between 1 and 100"
      }
    });
});
```

---

### 23. Test invalid severity

```
it("should reject an invalid severity", async () => {

  const response =
    await request(app)
      .get("/incidents")
      .query({
        severity: "banana"
      });

  expect(response.status)
    .toBe(400);

  expect(response.body)
    .toEqual({
      success: false,
      error: {
        code: "INVALID_SEVERITY",
        message: "Invalid severity"
      }
    });
});
```

---

### 24. Run the test suite

Run:
```
npm run build
```
Then:
```
npm run test:run
```
At this point, you may discover some old tests fail.

That's expected.

In particular, remember our old health test may still expect:
```
{
  "status": "ok",
  "service": "production-intelligence-platform"
}
```

while the current health controller may return:
```
{
  "status": "ok",
  "service": "production-intelligence-platform",
  "database": "connected"
}
```
`Don't randomly modify tests just to make them green.`

Determine whether:
```
implementation is wrong
```
or:
```
test represents an obsolete contract
```
Then update deliberately.

---

### 25. Important contract rule

Once an API contract is public:
```
Frontend
   ↓
API contract
   ↓
Backend
```
changing:
```
{
  "data": []
}
```
into:
```
{
  "results": []
}
```
can break clients.
That's why response contracts deserve deliberate design.

---

### 26. Our API contract now
#### Single resource
```
{
  "success": true,
  "data": {
    "id": "...",
    "service": "payment-service",
    "severity": "critical",
    "status": "detected"
  }
}
```
#### Collection
```
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "hasNextPage": true
  }
}
```
#### Error
```
{
  "success": false,
  "error": {
    "code": "INCIDENT_NOT_FOUND",
    "message": "Incident not found"
  }
}
```
This gives the frontend a predictable contract.

---

### 27. One thing we are deliberately NOT doing yet

You may notice we don't have:
```
total
totalPages
```
such as:
```
{
  "total": 10000000,
  "totalPages": 500000
}
```
Why?

Because calculating an exact total can require additional database work.

For high-volume APIs, we don't necessarily need exact totals for every request.

Our initial contract only needs:
```
page
limit
hasNextPage
```

Later we'll discuss when exact counts are useful.

---

### 28. Current architecture

Our request now flows like this:

```
GET /incidents
       ↓
Route
       ↓
Query Validation
       ↓
Controller
       ↓
IncidentService
       ↓
IncidentRepository
       ↓
Parameterized SQL
       ↓
PostgreSQL
       ↓
PaginatedResult
       ↓
Response Contract
       ↓
Client


```
That's becoming a proper backend architecture.

---

### 29. Testing architecture

We now have:
```
Unit tests
    ↓
Service business logic

API tests
    ↓
HTTP + Express + DB

Database constraints
    ↓
PostgreSQL integrity
```
So a bug has multiple opportunities to be caught.

---
