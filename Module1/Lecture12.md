### Module 1 — Lecture 12
### Database Constraints & Data Integrity

Today we're going to make an important architectural transition:

`The application should validate data, but PostgreSQL must also protect the data.`

Right now our validator prevents things like:
```
{
  "service": "payment-service",
  "severity": "invalid"
}
```
But someone can bypass our API and directly execute:
```
INSERT INTO incidents (...);
```
If PostgreSQL doesn't have constraints, invalid data can enter the system.

For a production system, `the database is the final line of defense.`

---

### 1. Our current problem

Currently:
```
Client
  ↓
Express
  ↓
Validator
  ↓
Service
  ↓
Repository
  ↓
PostgreSQL
```
We validate:
```
service
severity
```
But PostgreSQL currently allows:
```
severity = 'banana'
```
because we only have:
```
severity VARCHAR(20) NOT NULL
```
VARCHAR(20) means:

`"It must be a string with at most 20 characters."`

It does `not` mean:

`"It must be low, medium, high, or critical."`

---

### 2. Defense in depth

We want:
```
                 ┌──────────────┐
                 │ API validation│
                 └──────┬───────┘
                        ↓
                 ┌──────────────┐
                 │Service rules │
                 └──────┬───────┘
                        ↓
                 ┌──────────────┐
                 │ DB constraints│
                 └──────────────┘
```
Each layer protects us differently.

#### API

Good user experience:
```
400 Bad Request
```
#### Service

Protects business logic.
#### Database

Protects `data integrity regardless of where the write comes from.`
---

### 3. Constraint types we need

For our incident platform, we'll learn:
```
NOT NULL
PRIMARY KEY
FOREIGN KEY
UNIQUE
CHECK
DEFAULT
```
We've already used some of these.

Today we're going to understand them properly and add the missing constraints.
---
### 4. NOT NULL

We already have:
```
service VARCHAR(100) NOT NULL
```
This prevents:
```
INSERT INTO incidents (
    id,
    service,
    severity,
    status
)
VALUES (
    gen_random_uuid(),
    NULL,
    'critical',
    'detected'
);
```
PostgreSQL rejects it.

Why?

Because an incident without a service doesn't make sense.
---
### 5. PRIMARY KEY

Our table has:
```
id UUID PRIMARY KEY
```
This gives us two guarantees:
```
id cannot be NULL
id must be unique
```
So we cannot have:
```
incident A → id = abc
incident B → id = abc
```
PostgreSQL prevents it.
---
### 6. Foreign key

Our event table contains:
```
incident_id UUID NOT NULL
    REFERENCES incidents(id)
```
This means:
```
incident_events
      │
      │ incident_id
      ↓
incidents.id
```
You cannot create an event for an incident that doesn't exist.

Try:
```
INSERT INTO incident_events (
    incident_id,
    event_type
)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'INCIDENT_CREATED'
);
```
If that incident doesn't exist, PostgreSQL should reject it.

This prevents `orphan records`.

---

### 7. Let's test the foreign key

First create a real incident:
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
)
RETURNING id;
```
Copy the returned UUID.

Suppose PostgreSQL returns:
```
6a9c...
```
Now:
```
INSERT INTO incident_events (
    incident_id,
    event_type
)
VALUES (
    '6a9c...',
    'INCIDENT_CREATED'
);
```
That should succeed.

Now try a random UUID:
```
INSERT INTO incident_events (
    incident_id,
    event_type
)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'INCIDENT_CREATED'
);
```
Expected:
```
ERROR: insert or update on table "incident_events"
violates foreign key constraint
```
Excellent.

The database protected us.

---

### 8. The biggest missing constraint: severity

Our current column:
```
severity VARCHAR(20) NOT NULL
```
allows:
```
low
medium
high
critical
banana
xyz
hello
123
```
We need:
```
low
medium
high
critical
```
only.

PostgreSQL provides `CHECK`.
---

### 9. CHECK constraint

A `CHECK` constraint says:

`Every inserted/updated row must satisfy this condition.`

Example:
```
CHECK (
    severity IN (
        'low',
        'medium',
        'high',
        'critical'
    )
)
```
Now:
```
severity = critical
```
✅

but:
```
severity = banana
```
❌
---

### 10. Status needs a constraint too

Our domain currently defines:
```
type IncidentStatus =
  | "detected"
  | "investigating"
  | "acknowledged"
  | "mitigating"
  | "resolved"
  | "closed";
```
But PostgreSQL currently accepts:
```
status = "whatever"
```
That's dangerous.
We should enforce the same domain values at the database level.
---
### 11. Create migration 005

Create:
```
src/database/migrations/005_add_incident_domain_constraints.sql
```
Add:
```
ALTER TABLE incidents
ADD CONSTRAINT incidents_severity_check
CHECK (
    severity IN (
        'low',
        'medium',
        'high',
        'critical'
    )
);

ALTER TABLE incidents
ADD CONSTRAINT incidents_status_check
CHECK (
    status IN (
        'detected',
        'investigating',
        'acknowledged',
        'mitigating',
        'resolved',
        'closed'
    )
);
```
---

### 12. Run migration

Run:
```
npm run migrate
```
Expected:
```
Running migration: 005_add_incident_domain_constraints
Migration completed: 005_add_incident_domain_constraints

Database migrations completed.
```
Run it again:
```
npm run migrate
```
It should not execute migration 005 again.

---
### 13. Verify the constraints

Enter PostgreSQL:
```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```
Then:
```
\d incidents
```
You should see something similar to:
```
Check constraints:
    "incidents_severity_check"
    "incidents_status_check"
 ```
 ---

### 14. Break the database intentionally

This is important.

We don't just want to create constraints.

We want to `prove they work`.

Run:
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
    'banana',
    'detected'
);
```
Expected:
```
violates check constraint
"incidents_severity_check"
```
That is exactly what we want.

---
### 15. Test status

Try:
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
    'banana'
);
```
Expected:
```
ERROR:
violates check constraint
"incidents_status_check"
```
Our database is now enforcing the domain.

---

### 16. Why not use PostgreSQL ENUM?

You may wonder:

`Why are we using VARCHAR + CHECK instead of PostgreSQL ENUM?`

PostgreSQL supports:
```
CREATE TYPE incident_severity AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);
```
This is a legitimate approach.

But ENUMs introduce migration considerations when values change.

For example:
```
low
medium
high
critical
```

Later we might decide to add:
```
emergency
```
Changing an ENUM requires its own migration.

For this project, we'll use:
```
VARCHAR + CHECK
```
because it makes domain evolution and migration behavior easier to understand.

---
### 17. Add event constraints

Currently:
```
event_type VARCHAR(50) NOT NULL
```
Technically this allows:
```
banana
xyz
whatever
```
Our platform will eventually have well-defined event types.

For now, define:
```
INCIDENT_CREATED
INCIDENT_ACKNOWLEDGED
INCIDENT_STATUS_CHANGED
INCIDENT_RESOLVED
INCIDENT_CLOSED
```
Create:
```
src/database/migrations/006_add_incident_event_constraints.sql
```
```
ALTER TABLE incident_events
ADD CONSTRAINT incident_events_event_type_check
CHECK (
    event_type IN (
        'INCIDENT_CREATED',
        'INCIDENT_ACKNOWLEDGED',
        'INCIDENT_STATUS_CHANGED',
        'INCIDENT_RESOLVED',
        'INCIDENT_CLOSED'
    )
);
```
Then:
```
npm run migrate

```

---

### 18. Test it

This should fail:
```
INSERT INTO incident_events (
    incident_id,
    event_type
)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'BANANA'
);
```
It could actually fail because of the foreign key first.

So use a real incident ID.

Get one:
```
SELECT id
FROM incidents
LIMIT 1;
```
Then:
```
INSERT INTO incident_events (
    incident_id,
    event_type
)
VALUES (
    'REAL-INCIDENT-ID-HERE',
    'BANANA'
);
```
Expected:
```
violates check constraint
```
---

### 19. UNIQUE constraints

Now let's discuss another important constraint.

Imagine we eventually have an external incident identifier:

```
external_id
```
For example:
```
pagerduty-12345
```
We might require:
```
external_id must be unique
```
Then:
```
UNIQUE (external_id)
```
means:
```
incident A → pagerduty-12345 ✅
incident B → pagerduty-12345 ❌
```

This is especially important in distributed systems.

Why?

Because retries can happen.

Suppose:
```
External system
      ↓
POST /incidents
      ↓
Database INSERT
      ↓
Network timeout
```
The client doesn't know whether the request succeeded.

It retries.

Without an idempotency/unique constraint, we could create:
```
Incident #1
Incident #2
```
for the same external event.
We'll eventually solve this properly with `idempotency keys`.

That becomes especially important when we reach our distributed systems modules.

### 20. NOT NULL vs CHECK

Understand this distinction.

#### NOT NULL
```
service VARCHAR(100) NOT NULL
```
Means:

`A value must exist.`

#### CHECK
```
CHECK (severity IN (...))
```
Means:

`The value must satisfy a rule.`

Therefore:
```
NULL
```
and:
```
banana
```
are different problems.
---
### 21. Application validation vs database constraints

Suppose someone sends:
```
{
  "service": "",
  "severity": "banana"
}
```
Our API validator should reject it.

Why?

Because we want a nice response:
```
{
  "success": false,
  "error": {
    "code": "INVALID_SEVERITY",
    "message": "Invalid severity"
  }
}
```

But suppose someone bypasses our API:
```
INSERT ...
```
The database still needs to reject it.

So:
```
Application validation
        ↓
Good API experience

Database constraints
        ↓
Data integrity
```
`Never rely exclusively on application validation for critical data integrity.`

---

### 22. Very important production concept

There are two different kinds of rules.

#### Business validation

Example:

`An incident can only be closed after it has been resolved.`

That is business logic.

We should eventually implement that in the service/domain layer.

#### Data integrity

Example:

`An incident severity must be one of four values.`

That belongs naturally at the database level too.

So:
```
"Can this action happen?"
        ↓
Business logic

"Can this data exist?"
        ↓
Database constraint
```
There is some overlap, but this distinction is extremely useful.
---

### 23. Our architecture now
```
             HTTP Request
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
           Business Rules
                  │
                  ▼
             Repository
                  │
                  ▼
            PostgreSQL
                  │
       ┌──────────┴──────────┐
       │                     │
       ▼                     ▼
   Constraints          Foreign Keys
       │                     │
       └──────────┬──────────┘
                  ▼
             Valid Data
```
This is `defense in depth`.

---
### 24. One more important thing: constraint naming

Notice we explicitly named our constraints:
```
incidents_severity_check
incidents_status_check
incident_events_event_type_check
```
Instead of letting PostgreSQL generate names.

That's intentional.

When something fails, PostgreSQL can tell us:
```
violates check constraint
"incidents_severity_check"
```
That becomes very useful for:

- debugging
- logs
- error mapping
- database operations
- production incidents

Good constraint names are part of good database design.

---