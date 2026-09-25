### Module 1 — Lecture 13
### SQL Query Design + Indexes

Today we start one of the most important PostgreSQL topics for a backend engineer:

`Writing SQL that is correct, predictable, and efficient.`

We won't just learn SQL syntax. We'll learn how PostgreSQL executes queries and why indexes matter.

Our incident platform will eventually contain millions of incidents and potentially hundreds of millions of events. A query that works on 100 rows can become a production problem at that scale.

---

### 1. Our database

We currently have:
```
incidents
├── id
├── service
├── severity
├── status
├── created_at
├── updated_at
└── acknowledged_at

incident_events
├── id
├── incident_id
├── event_type
└── created_at
```
Let's first put some realistic data into the database.

---

### 2. Insert test incidents

Open PostgreSQL:
```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```
Insert:

```
INSERT INTO incidents (
    id,
    service,
    severity,
    status
)
VALUES
(
    gen_random_uuid(),
    'payment-service',
    'critical',
    'detected'
),
(
    gen_random_uuid(),
    'payment-service',
    'high',
    'investigating'
),
(
    gen_random_uuid(),
    'user-service',
    'medium',
    'acknowledged'
),
(
    gen_random_uuid(),
    'order-service',
    'critical',
    'mitigating'
),
(
    gen_random_uuid(),
    'order-service',
    'low',
    'resolved'
),
(
    gen_random_uuid(),
    'notification-service',
    'high',
    'closed'
);

```

Verify:
```
SELECT
    id,
    service,
    severity,
    status
FROM incidents;
```

---

### 3. Query #1 — WHERE

The simplest filtering query:
```
SELECT *
FROM incidents
WHERE service = 'payment-service';
```
PostgreSQL should return the payment incidents.

The conceptual operation is:
```
all incidents
      ↓
WHERE service = payment-service
      ↓
matching incidents
```

---

### 4. Multiple conditions
```
SELECT *
FROM incidents
WHERE service = 'payment-service'
AND severity = 'critical';
```
Now both conditions must be true.

Think:
```
service = payment-service
        AND
severity = critical
```

---

### 5. OR
```
SELECT *
FROM incidents
WHERE severity = 'critical'
OR severity = 'high';
```
This returns:
```
critical
high
```
Be careful with complex conditions.

For example:
```
SELECT *
FROM incidents
WHERE service = 'payment-service'
AND severity = 'critical'
OR status = 'investigating';
```
SQL operator precedence can make this behave differently than someone might visually expect.

Use parentheses when expressing business logic:
```
SELECT *
FROM incidents
WHERE (
    service = 'payment-service'
    AND severity = 'critical'
)
OR status = 'investigating';
```
This is much clearer.

---

### 6. IN

Instead of:
```
WHERE severity = 'critical'
OR severity = 'high'
```
we can write:
```
SELECT *
FROM incidents
WHERE severity IN ('critical', 'high');
```
This is cleaner.

Our future incident APIs will use patterns like this frequently.

---

### 7. ORDER BY

Suppose we want newest incidents first:
```
SELECT *
FROM incidents
ORDER BY created_at DESC;
```
DESC means:
```
newest → oldest
```
while:
```
ORDER BY created_at ASC;
```
means:
```
oldest → newest
```
---

### 8. LIMIT

Suppose the UI only needs 10 incidents:
```
SELECT *
FROM incidents
ORDER BY created_at DESC
LIMIT 10;
```
This becomes important when we build our incident dashboard.

We don't want:
```
10 million rows
       ↓
database
       ↓
Node.js
       ↓
browser
```
We want:

```
database
   ↓
10 rows
   ↓
Node.js
   ↓
browser
```
Filtering and limiting should happen as close to the database as possible.

---

### 9. OFFSET

For traditional pagination:
```
SELECT *
FROM incidents
ORDER BY created_at DESC
LIMIT 20
OFFSET 40;
```
Conceptually:
```
page 1 → OFFSET 0
page 2 → OFFSET 20
page 3 → OFFSET 40
```
We'll discuss why OFFSET becomes problematic at scale in `Lecture 14`.

For now, understand the mechanics.

---

### 10. COUNT

How many incidents do we have?
```
SELECT COUNT(*)
FROM incidents;
```
We can give it a useful name:
```
SELECT COUNT(*) AS total_incidents
FROM incidents;
```
Result:
```
total_incidents
---------------
6
```

---

### 11. GROUP BY

Now ask:

How many incidents does each service have?
```
SELECT
    service,
    COUNT(*) AS incident_count
FROM incidents
GROUP BY service;
```
Conceptually:
```
payment-service       2
user-service          1
order-service         2
notification-service  1
```
This is extremely useful for our future operations dashboard.

---

### 12. GROUP BY severity
```
SELECT
    severity,
    COUNT(*) AS incident_count
FROM incidents
GROUP BY severity;
```
We could get:
```
critical    2
high        2
medium      1
low         1
```
---

### 13. GROUP BY multiple columns

We can also ask:

`How many incidents exist for each service/severity combination?`
```
SELECT
    service,
    severity,
    COUNT(*) AS incident_count
FROM incidents
GROUP BY
    service,
    severity;
```
This gives us a two-dimensional aggregation.

---

### 14. HAVING

This is an important distinction.

WHERE filters `rows before grouping`.

HAVING filters `groups after grouping`.

For example:
```
SELECT
    service,
    COUNT(*) AS incident_count
FROM incidents
GROUP BY service
HAVING COUNT(*) >= 2;
```
Meaning:

`Show only services with at least two incidents.`

Think:

```
WHERE
 ↓
rows
 ↓
GROUP BY
 ↓
groups
 ↓
HAVING
 ↓
filtered groups
```

---

### 15. JOIN

Now we move to something very important.

We have:
```
incidents
     │
     │ id
     │
     ▼
incident_events.incident_id
```
Let's retrieve incidents and their events.
```
SELECT
    incidents.id,
    incidents.service,
    incidents.severity,
    incident_events.event_type,
    incident_events.created_at
FROM incidents
JOIN incident_events
    ON incident_events.incident_id = incidents.id;
```
This connects the two tables.

---

### 16. Understand the JOIN

Suppose:

#### incidents
```
id      service
----------------
A       payment
B       order
```
#### incident_events
```
incident_id    event_type
-------------------------
A              CREATED
A              ACKNOWLEDGED
B              CREATED
```
The JOIN produces:
```
payment    CREATED
payment    ACKNOWLEDGED
order      CREATED
```
One incident can therefore produce multiple result rows.

---

### 17. LEFT JOIN

Suppose an incident has no events.

With:
```
JOIN
```
that incident won't appear.

With:
```
LEFT JOIN
```
it will.
```
SELECT
    incidents.id,
    incidents.service,
    incident_events.event_type
FROM incidents
LEFT JOIN incident_events
    ON incident_events.incident_id = incidents.id;
```
Conceptually:
```
incidents
    ↓
ALL incidents
    ↓
events if they exist
```
This is extremely useful for reporting.

---

### 18. Why indexes exist

Now we reach the most important part of this lecture.

Suppose:
```
incidents = 10 rows
```
A simple query is fast.

Now imagine:
```
incidents = 10,000,000 rows
```
And we run:
```
SELECT *
FROM incidents
WHERE service = 'payment-service';
```
How does PostgreSQL find those rows?

Without an appropriate index, PostgreSQL may need to inspect a large portion of the table.

Conceptually:
```
Row 1   → check
Row 2   → check
Row 3   → check
...
Row 10,000,000 → check
```
That's a `sequential scan`.

---

### 19. What an index does

An index is an additional data structure that helps PostgreSQL locate rows efficiently.

Conceptually:
```
Table

1 payment
2 order
3 user
4 payment
5 notification
...
```
Index:
```
payment       → rows 1,4,...
notification  → row 5,...
order         → row 2,...
user          → row 3,...
```
So instead of inspecting every row:

```
Query
 ↓
Index
 ↓
matching rows
 ↓
Table
```
For common lookup patterns, this can dramatically reduce work.

---

### 20. Our existing indexes

Remember Lecture 11?

We created:
```
CREATE INDEX idx_incidents_service
ON incidents(service);

CREATE INDEX idx_incidents_status
ON incidents(status);

CREATE INDEX idx_incident_events_incident_id
ON incident_events(incident_id);
```
Let's inspect them.

Run:
```
\d incidents
```
You should see something similar to:

```
Indexes:
    "incidents_pkey" PRIMARY KEY
    "idx_incidents_service" btree (service)
    "idx_incidents_status" btree (status)
```
The primary key automatically has an index.

---

### 21. Why does PRIMARY KEY have an index?

We frequently execute:

```
SELECT *
FROM incidents
WHERE id = $1;
```
Because id is:
```
PRIMARY KEY
```
PostgreSQL creates an index for it automatically.

This is why:
```
findById(id)
```
can efficiently locate an incident.

---

### 22. EXPLAIN

Now we need to learn how to inspect PostgreSQL's query plan.

Run:

EXPLAIN
```
SELECT *
FROM incidents
WHERE service = 'payment-service';
```
You might see something like:
```
Seq Scan on incidents
```
Don't panic.

Our table has only a few rows.

PostgreSQL may correctly decide:

`"Scanning this tiny table is cheaper than using the index."`

This is a `very important lesson`.
`An index does NOT mean PostgreSQL must use the index.`

PostgreSQL's query planner chooses a plan based on estimated cost.

---

### 23. EXPLAIN ANALYZE

Now:

EXPLAIN ANALYZE
```
SELECT *
FROM incidents
WHERE service = 'payment-service';
```
This actually executes the query and reports information such as:
```
Planning Time
Execution Time
actual rows
actual loops
```
This is one of the most useful tools you'll learn as a backend engineer.

---

### 24. EXPLAIN vs EXPLAIN ANALYZE
#### EXPLAIN
```
EXPLAIN SELECT ...
```
Shows the `planned execution strategy`.

#### EXPLAIN ANALYZE
```
EXPLAIN ANALYZE SELECT ...
```
Actually executes the query and shows `real execution statistics`.

Remember:
```
EXPLAIN
    ↓
"What does PostgreSQL plan to do?"

EXPLAIN ANALYZE
    ↓
"What actually happened when it ran?"
```

----

### 25. Why our tiny table may use Seq Scan

This is a classic interview question.

You might think:

`"We created an index, so PostgreSQL should use it."`

Not necessarily.

Imagine:
```
Table = 6 rows
```
Using the index may require:
```
Index lookup
    ↓
find row locations
    ↓
fetch rows
```
Scanning six rows may simply be cheaper.

PostgreSQL's optimizer considers estimated cost.

Therefore:

`Don't judge index usage from tiny development datasets alone.`

---

### 26. Check index usage on a larger dataset

We can generate test data.

Run:

```
INSERT INTO incidents (
    id,
    service,
    severity,
    status
)
SELECT
    gen_random_uuid(),
    CASE
        WHEN random() < 0.4
            THEN 'payment-service'
        WHEN random() < 0.7
            THEN 'order-service'
        ELSE
            'user-service'
    END,
    CASE
        WHEN random() < 0.1
            THEN 'critical'
        WHEN random() < 0.3
            THEN 'high'
        WHEN random() < 0.7
            THEN 'medium'
        ELSE
            'low'
    END,
    CASE
        WHEN random() < 0.2
            THEN 'detected'
        WHEN random() < 0.4
            THEN 'investigating'
        WHEN random() < 0.6
            THEN 'acknowledged'
        WHEN random() < 0.8
            THEN 'mitigating'
        WHEN random() < 0.9
            THEN 'resolved'
        ELSE
            'closed'
    END
FROM generate_series(1, 100000);

```

Now:
```
SELECT COUNT(*)
FROM incidents;
```
You should have roughly:
```
100006
```
depending on your previous rows.

---

### 27. Run EXPLAIN ANALYZE again

Now:

```
EXPLAIN ANALYZE
SELECT *
FROM incidents
WHERE service = 'payment-service';
```
Look at the plan.

You may see:
```
Index Scan
```
or:
```
Bitmap Heap Scan
Bitmap Index Scan
```
depending on PostgreSQL's cost estimates and data distribution.

Don't memorize the exact plan.

The important lesson is:

`PostgreSQL chooses the execution strategy.`

---

### 28. Bitmap scans

You may encounter:
```
Bitmap Index Scan
        ↓
Bitmap Heap Scan
```
This often appears when PostgreSQL expects multiple rows to match.

Conceptually:
```
Index
 ↓
find many matching row locations
 ↓
organize those locations
 ↓
fetch table pages efficiently
```
We'll study execution plans much more deeply later.

For now, recognize the terminology.

---

### 29. Composite indexes

Suppose our API frequently asks:
```
SELECT *
FROM incidents
WHERE service = 'payment-service'
AND status = 'investigating';
```
We might consider:
```
CREATE INDEX idx_incidents_service_status
ON incidents(service, status);
```
This is called a composite index.

The order matters.
```
(service, status)
```
is not equivalent to:

```
(status, service)
```
in every query-planning situation.

We'll study this deeply in the next lecture.

---

### 30. Don't create indexes everywhere

This is a common beginner mistake.

You might think:

`More indexes = faster database`

No.

Indexes have costs.

When we insert:
```
INSERT INTO incidents ...
```
PostgreSQL must maintain the relevant indexes too.

So:
```
More indexes
     ↓
Faster certain reads
     ↓
More storage
     ↓
More write overhead
```
Therefore:

`Indexes should be created based on query patterns, not because a column exists.`

---

### 31. Production mindset

Suppose our incident API eventually has:
```
GET /incidents
GET /incidents?service=payment-service
GET /incidents?status=investigating
GET /incidents?severity=critical
GET /incidents?service=payment-service&status=investigating
```
We shouldn't randomly create:
```
index service
index status
index severity
index everything
```
Instead:
```
1. Identify important queries
2. Measure query plans
3. Understand data distribution
4. Create appropriate indexes
5. Measure again
```
That is database engineering.

---

### 32. One very important distinction

An index helps PostgreSQL `find rows`.

It does not automatically make every query fast.

For example:
```
SELECT *
FROM incidents
WHERE LOWER(service) = 'payment-service';
```
An ordinary index on:
```
service
```
may not be directly usable in the desired way because the query applies a function.

There are specialized techniques such as expression indexes.

We'll get into these later.

---

### 33. Our Repository should reflect query design

Our repository currently has:
```
findById(id)
```
Soon we will add methods such as:
```
findIncidents()
findByService()
findByStatus()
findBySeverity()
```
But we shouldn't create one SQL query per possible combination blindly.

We'll design the query API around the actual requirements.

That's why today's SQL knowledge matters.

---

### 34. A production query example

Eventually our incident dashboard might need:

`Give me the latest 20 unresolved critical/high incidents for payment-service.`

A query might look like:
```
SELECT
    id,
    service,
    severity,
    status,
    created_at,
    updated_at
FROM incidents
WHERE service = 'payment-service'
  AND severity IN ('critical', 'high')
  AND status NOT IN ('resolved', 'closed')
ORDER BY created_at DESC
LIMIT 20;
```
This is a real operational query.

The database should do the filtering:

```

100 million incidents
        ↓
service filter
        ↓
severity filter
        ↓
status filter
        ↓
sort
        ↓
20 rows
```
Not Node.js.

---

### 35. Your practical exercise

Run these queries yourself.

#### Exercise 1
```
SELECT *
FROM incidents
WHERE severity = 'critical';
```
#### Exercise 2
```
SELECT
    service,
    COUNT(*) AS total
FROM incidents
GROUP BY service;
```
#### Exercise 3

```
SELECT
    status,
    COUNT(*) AS total
FROM incidents
GROUP BY status
ORDER BY total DESC;
```
#### Exercise 4
```
SELECT
    service,
    severity,
    COUNT(*) AS total
FROM incidents
GROUP BY service, severity
ORDER BY total DESC;
```
#### Exercise 5

```
EXPLAIN ANALYZE
SELECT *
FROM incidents
WHERE service = 'payment-service';
```

---

### 36. Important commands to learn

Keep these in your toolbox:
```
\d incidents
```
Inspect table structure.
```
\di
```
List indexes.
```
EXPLAIN
SELECT ...;
```
Inspect planned query.
```
EXPLAIN ANALYZE
SELECT ...;
```
Execute and measure the query.
```
SELECT COUNT(*)
FROM incidents;
```
Measure table size in rows.

---