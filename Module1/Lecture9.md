### Lecture 9 — PostgreSQL Transactions + Rollback

We now have:

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
```

But there's an important production problem.

Suppose creating an incident eventually requires ***multiple database operations:***

```
Create incident
     ↓
Create incident event
     ↓
Update service statistics
     ↓
Update incident counter
```

What happens if:

```
Operation 1 ✅
Operation 2 ✅
Operation 3 ❌
```

Without a transaction, the database could be left partially updated.

We need:

```
BEGIN
  Operation 1
  Operation 2
  Operation 3
COMMIT
```

or, if anything fails:

```
BEGIN
  Operation 1
  Operation 2
  Operation 3 ❌
ROLLBACK
```
---

### 1. What is a transaction?

A PostgreSQL transaction groups multiple operations into ***one logical unit of work.***

Think:

```
                  TRANSACTION
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Query 1     Query 2     Query 3
          │           │           │
          └───────────┼───────────┘
                      │
                    COMMIT
```

If everything succeeds:

```
COMMIT
```

If anything fails:

```
ROLLBACK
```

---

### 2. ACID

Transactions are commonly explained through ***ACID.***

### A — Atomicity

All operations succeed or none do.

```
1 ✅
2 ✅
3 ❌
→ rollback

```


### C — Consistency

The database moves from one valid state to another valid state.

### I — Isolation

Concurrent transactions shouldn't improperly interfere with each other.

### D — Durability

Once committed, the change remains persisted.

We'll spend much more time on isolation later when we study distributed systems.

For today, focus on:

 - **Atomicity**

---

### 3. Our first transaction manually

Open PostgreSQL:
```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```

Check:
```
SELECT COUNT(*) FROM incidents;
```

Now:
```
BEGIN;
```

Insert:

```

INSERT INTO incidents (
    id,
    service,
    severity,
    status
)
VALUES (
    gen_random_uuid(),
    'payment-service',
    'critical',
    'detected'
);

```

Check:

```
SELECT * FROM incidents;
```

You can see the new row.

But now:

```
ROLLBACK;
```

Check again:

```

SELECT * FROM incidents;

```

The inserted row should be gone.

🎯 That's rollback.

---

### 4. Now try COMMIT

Again:

```
BEGIN;
```

Then:

```
INSERT INTO incidents (
    id,
    service,
    severity,
    status
)
VALUES (
    gen_random_uuid(),
    'inventory-service',
    'high',
    'detected'
);

```

Then:

```
COMMIT;
```

Now:

```

SELECT * FROM incidents;

```

The row remains.

So:

```
BEGIN
 ↓
INSERT
 ↓
COMMIT
 ↓
Permanent
```

while:

```

BEGIN
 ↓
INSERT
 ↓
ROLLBACK
 ↓
Gone

```

---

### 5. The problem with our current repository

Currently we're doing:
```
await pool.query(...)
```

The `Pool` manages connections for us.

That's perfect for independent queries.

But a transaction requires something more specific:

```
Get one connection
       ↓
BEGIN
       ↓
Query 1
       ↓
Query 2
       ↓
COMMIT
       ↓
Release connection
```

All queries belonging to the transaction must execute on the ***same PostgreSQL client/connection.***

---

### 6. pool.query() vs client.query()

This distinction is extremely important.

### Simple query
```
await pool.query(
  "SELECT * FROM incidents"
);
```

Fine.

### Transaction

We need:

```
const client = await pool.connect();

await client.query("BEGIN");

await client.query(...);
await client.query(...);

await client.query("COMMIT");

client.release();

```


Because the same client must maintain the transaction.

---

### 7. Create a transaction helper

Create:
```
src/database/transaction.ts
```

```
import type { PoolClient } from "pg";
import { pool } from "./pool.js";

export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await callback(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
};

```

This is a very useful abstraction

---

### 8. Understand the lifecycle

Our helper does:

```
pool.connect()
      │
      ▼
   client
      │
      ▼
   BEGIN
      │
      ▼
 callback()
      │
   ┌──┴──┐
   │     │
Success Failure
   │     │
   ▼     ▼
COMMIT ROLLBACK
   │     │
   └──┬──┘
      ▼
 release()
```

The `finally `block is particularly important.

Regardless of success or failure:

```
client.release();
```

must happen.

Otherwise you can eventually exhaust the connection pool.

---

### 9. Why finally?

Imagine:

```
max connections = 10

```

If we forget:
```
client.release();
```

then connections remain occupied.

Eventually:
```

Request 1 → connection
Request 2 → connection
Request 3 → connection
...
Request 10 → connection
Request 11 → waiting...
Request 12 → waiting...

```

Potentially your application becomes unable to talk to PostgreSQL.

So:
```

finally {
  client.release();
}

```

is not cosmetic.

It's critical resource management

---


### 10. Let's create a transactional operation

We'll add an incident event table.

Why?

Because our eventual platform is event-driven.

An incident shouldn't just exist as a row.

Eventually we'll want history:

```
Incident created
Incident acknowledged
Incident investigating
Incident resolved
```

Create this table.

Open PostgreSQL:
```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```

### Note - Direct run in pg admin 
Run:

```
CREATE TABLE incident_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id),
    event_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Verify:
```
\d incident_events
```

---


### 11. Why the foreign key?

This:
```
incident_id UUID NOT NULL REFERENCES incidents(id)
```

means an event must point to an existing incident.

For example:
```
Incident
ID = A
   │
   ├── CREATED
   ├── ACKNOWLEDGED
   └── RESOLVED
```

But this shouldn't be allowed:
```
Event
incident_id = Z
```

if incident `Z` doesn't exist.

PostgreSQL enforces that relationship.

---

### 12. Create event repository

Create:

```
src/repositories/incident-event.repository.ts

```

```
import type { PoolClient } from "pg";

interface CreateIncidentEventData {
  incidentId: string;
  eventType: string;
}

export class IncidentEventRepository {
  async create(
    client: PoolClient,
    data: CreateIncidentEventData
  ) {
    const query = `
      INSERT INTO incident_events (
        incident_id,
        event_type
      )
      VALUES ($1, $2)
      RETURNING
        id,
        incident_id,
        event_type,
        created_at
    `;

    const result = await client.query(query, [
      data.incidentId,
      data.eventType
    ]);

    return result.rows[0];
  }
}
```

Notice:

We're passing:

```
client
```

rather than using:
```
pool
```

because this operation must participate in the transaction.

---

### 13. Create transactional incident operation

Modify the service.

We need:

```
Create incident
      +
Create CREATED event
```


Both should succeed or fail together.

Update:


```
src/services/incident.service.ts

```

Add imports:

```
import { withTransaction } from "../database/transaction.js";
import { IncidentEventRepository } from "../repositories/incident-event.repository.js";

```

Create:
```
const incidentEventRepository =
  new IncidentEventRepository();

```

Then add

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

    await incidentEventRepository.create(client, {
      incidentId: incident.id,
      eventType: "INCIDENT_CREATED"
    });

    return incident;
  });
}
```

But we've discovered something important:

Our existing repository only has:

```
create()
```

which uses the pool.

We need a transaction-aware method.

---

### 14. Add createWithClient

In:

```
src/repositories/incident.repository.ts
```

add:
```
import type { PoolClient } from "pg";

```

Then:

```
async createWithClient(
  client: PoolClient,
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

  const result = await client.query(query, [
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
```

Now:
```
Normal operation
     ↓
pool.query()

Transaction
     ↓
client.query()
```

---

### 15. Update the controller

Change:

```
incidentService.createIncident(...)
```

to:

```
incidentService.createIncidentWithEvent(...)
```

So:
```
export const createIncident = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const incident =
      await incidentService.createIncidentWithEvent({
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

### 16. What happens now?

Request:

```
POST /incidents
```

causes:
```
BEGIN
  │
  ├── INSERT incident
  │
  ├── INSERT INCIDENT_CREATED event
  │
  ▼
COMMIT

```

Database:

```

incidents
    │
    └── Incident A

incident_events
    │
    └── INCIDENT_CREATED → Incident A

```

---

### 17. Let's intentionally cause a failure

This is where the lecture becomes important.

Temporarily change:

```
eventType: "INCIDENT_CREATED"
```

to:
```
eventType: null as any
```

Don't worry about the temporary TypeScript shortcut—we're deliberately creating a database failure.

The database column is:

```
event_type VARCHAR(50) NOT NULL
```

So the second insert will fail.

Now send:

```

POST /incidents
```
```
{
  "service": "payment-service",
  "severity": "critical"
}

```

The flow should be:

```
BEGIN
  ↓
INSERT incident ✅
  ↓
INSERT event ❌
  ↓
ROLLBACK

```

The API should return an error.

Now query:

```

SELECT * FROM incidents
ORDER BY created_at DESC;
```

The newly attempted incident should **not exist.**

That's the key lesson.

Without the transaction:

```
incident inserted ✅
event failed ❌
```

You could have ended with inconsistent state.

With the transaction:

```
incident inserted
event failed
      ↓
ROLLBACK
      ↓
incident removed

```

---

### 18. Restore the code

Change:

```
eventType: null as any

```

back to:
```
eventType: "INCIDENT_CREATED"
```

Run:

```
npm run build

```

Then:
```
npm run test:run
```

---

### 19. Test the successful transaction

Create an incident:
```
{
  "service": "payment-service",
  "severity": "critical"
}
```

Then:

```
SELECT
    id,
    service,
    severity,
    status
FROM incidents
ORDER BY created_at DESC
LIMIT 1;

```

Then:

```
SELECT
    incident_id,
    event_type
FROM incident_events
ORDER BY created_at DESC
LIMIT 1;


```

You should see the same incident ID:

```
incidents
--------------------------------
id: ABC
service: payment-service

incident_events
--------------------------------
incident_id: ABC
event_type: INCIDENT_CREATED
```

That's our first transactional workflow.

---

### 20. A very important rule

Never do this:
```
BEGIN
 ↓
query using client
 ↓
query using pool
 ↓
COMMIT
```

For example:

```
await client.query("BEGIN");

await client.query("INSERT ...");

await pool.query("INSERT ...");

await client.query("COMMIT");
```

That's wrong.

Why?

Because:
```
client
```

and:

```
pool
```

may use different PostgreSQL connections.

Your transaction exists on `one connection.`

Correct:
```
client
 ↓
BEGIN
 ↓
query
 ↓
query
 ↓
COMMIT
```

---

### 21. Transaction boundary

This is an architectural concept you'll use throughout this project.

The service decides:

- **Which operations must succeed together?**

The repository decides:

 - **How do I execute the SQL?**

So:

```
Service
   │
   │ transaction boundary
   ▼
Repository
   │
   ├── SQL 1
   └── SQL 2
```

Not:

```
Repository
   │
   └── decides business transaction
```


The service understands the business operation.

---

### 22. Current architecture

Our application is becoming:

```
                         HTTP
                          │
                          ▼
                       Router
                          │
                          ▼
                      Validator
                          │
                          ▼
                      Controller
                          │
                          ▼
                       Service
                          │
                    ┌─────┴─────┐
                    │ Transaction│
                    └─────┬─────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
       Incident Repo             Event Repo
             │                         │
             └────────────┬────────────┘
                          ▼
                    PostgreSQL
```

This is already starting to resemble a real production backend.

---

### 23. One thing we are NOT doing yet

We're not adding:

```
❌ Redis
❌ BullMQ
❌ WebSockets
❌ Microservices
❌ Event broker

```


Why?

Because we first need to understand:

```
HTTP
 ↓
Database
 ↓
Transactions
 ↓
Consistency

```

Then we'll introduce asynchronous processing and distributed systems.

---

