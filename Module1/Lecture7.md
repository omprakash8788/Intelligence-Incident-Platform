### Lecture 7 — PostgreSQL + Docker + Database Connection

Now we're moving from a purely in-memory API to a ***real persistent backend.***

Our architecture becomes:

```
React
  │
  ▼
Express API
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

We're going to do this carefully:

- Run PostgreSQL with Docker
- Create the database
- Connect Node.js → PostgreSQL
- Use a connection pool
- Add a database health check
- Test the connection
- Understand connection pooling
- Verify everything before continuing

***We will use raw SQL first. No ORM yet.***

---

### 1. Why PostgreSQL now?

Our POST /incidents currently does this:

```
{
  "success": true,
  "data": {
    "service": "payment-service",
    "severity": "critical"
  }
}
```

But if we restart the server:

```
Data disappears ❌
```
We need:
```
POST /incidents
       ↓
PostgreSQL
       ↓
Data persists
```

This is our first real persistence layer.

---

### 2. Why Docker?

Instead of installing PostgreSQL directly on Windows, we'll run it in a container.

```
Windows
   │
   ▼
Docker
   │
   ▼
PostgreSQL Container

```

Benefits:

- Same database version for everyone
- Easy reset
- Easy backup/restore during development
- No machine-specific PostgreSQL installation
- Later we can add Redis to the same Compose environment

---

### 3. Check Docker

Run:
```
docker --version
```
Then:
```
docker compose version
```

You should get version information from both.

If Docker Desktop isn't running, start it first.

---

### 4. Create docker-compose.yml

At the project root:
```
production-intelligence-platform/
├── src/
├── tests/
├── .env
├── docker-compose.yml
├── package.json
└── tsconfig.json

```
Create:
```
docker-compose.yml
```
Use:
```
services:
  postgres:
    image: postgres:17
    container_name: production-intelligence-postgres
    restart: unless-stopped

    environment:
      POSTGRES_DB: production_intelligence
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres

    ports:
      - "5432:5432"

    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:

```

---

### 5. Understand the Compose file
### Image
```
image: postgres:17
```

We're using PostgreSQL 17.

#### Container name
```
container_name: production-intelligence-postgres
```

This gives the container a predictable name.

### Database
```
POSTGRES_DB: production_intelligence
```

The database will be:
```
production_intelligence
```
### Port
```
5432:5432
```

Means:
```
Host port 5432
       ↓
Container port 5432
```

So Node.js running on your Windows machine can connect to:
```
localhost:5432
```

##### Volume
```
postgres_data:/var/lib/postgresql/data
```

This is extremely important.

Without the volume, deleting the container can delete your development database.

With the volume:

```
Container
   │
   ▼
Persistent Volume
   │
   ▼
PostgreSQL data
```
---


### 6. Start PostgreSQL

Run:
```
docker compose up -d postgres
```

Check:
```
docker compose ps
```

You should see something similar to:

```
NAME                                  STATUS
production-intelligence-postgres       Up

```

---

### 7. Check PostgreSQL logs

Run:
```
docker compose logs postgres
```

You should eventually see something like:
```
database system is ready to accept connections
```

That's what we're looking for.

---

### 8. Connect using psql inside the container

You don't need PostgreSQL installed on Windows.

Run:
```

docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence

```

You should enter the PostgreSQL shell:

```
production_intelligence=#
```

Run:
```
SELECT version();

```

Then:
```
SELECT current_database();
```

Expected:
```
production_intelligence

```

Exit:
```

\q

```

---

### 9. Install PostgreSQL driver for Node.js

We'll use the standard `pg` library.

Run:
```
npm install pg
```

For TypeScript:
```
npm install -D @types/pg
```

---

### 10. Create database module

Create:
```
src/database/
```

Then:
```
src/database/pool.ts
```

Add:

```
import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = new Pool({
  host: env.postgres.host,
  port: env.postgres.port,
  database: env.postgres.database,
  user: env.postgres.user,
  password: env.postgres.password,

  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

```

---

### 11. What is a connection pool?

This is one of the most important concepts today.

A beginner might think:

```
Request
   ↓
Create DB connection
   ↓
Query
   ↓
Close connection

```

for every request.

That's inefficient.

Instead:

```
                 PostgreSQL
                     ▲
                     │
            ┌────────┴────────┐
            │ Connection Pool │
            └────────┬────────┘
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Conn 1      Conn 2      Conn 3
```

Requests borrow connections:
```
Request A → Connection 1
Request B → Connection 2
Request C → Connection 3
```

When finished:
```
Connection → Pool
```

It can then be reused.

---



### 12. What `does max: 10` mean?
```
max: 10
```

means our Node.js process can have up to approximately:
```
10 PostgreSQL connections
```

in the pool.

It does `not` mean every request gets its own permanent connection.

That's an important distinction

---



### 13. Test database connection

Create:
```
src/database/health.ts
```
```
import { pool } from "./pool.js";

export const checkDatabaseConnection = async () => {
  const result = await pool.query("SELECT 1");

  return result.rows[0];
};
```

Now we can ask PostgreSQL:
```

SELECT 1;
```

If PostgreSQL responds:
```

1

```

the connection works.

---

#### 14. Create database health endpoint

Modify:
```
src/controllers/health.controller.ts

```

```
import { Request, Response, NextFunction } from "express";
import { checkDatabaseConnection } from "../database/health.js";

export const healthController = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await checkDatabaseConnection();

    res.status(200).json({
      status: "ok",
      service: "production-intelligence-platform",
      database: "connected"
    });
  } catch (error) {
    next(error);
  }
};

```


Now /health verifies both:

```
Application
+
PostgreSQL

```

---

### 15. Test it

Note - VVI - manually create database inside pg admin

Note - Also update yml file -     image: postgres:18 (This is vvi)

Make sure PostgreSQL is running:
```
docker compose up -d postgres
```

Then:
```
npm run dev
```

Call:

```
GET /health
```

Expected:

```

{
  "status": "ok",
  "service": "production-intelligence-platform",
  "database": "connected"
}
```

Now our Node.js application is actually communicating with PostgreSQL

---

### 16. Test failure intentionally

This is important.

Stop PostgreSQL:

```

docker compose stop postgres

```

Now call:
```

GET /health

```

The request should fail.

You should `not` receive:

```

{
  "status": "ok"
}

```

because the database isn't healthy.

This demonstrates why our health endpoint is more than a simple:

```
res.json({ status: "ok" });
```
---


### 17. Start PostgreSQL again

```
docker compose start postgres

```

Then:

```

GET /health

```

should work again.

---

### 18. Important architecture decision

Our current health endpoint is:

```

GET /health
     │
     ├── Application
     │
     └── PostgreSQL


```

Later, we'll have:

```

GET /health

```

for basic process health, and potentially:
```

GET /ready

```

for readiness:

```

Application
     +
PostgreSQL
     +
Redis
     +
Required dependencies

```

This distinction becomes important when we deploy the system.

We won't implement readiness yet.

---


### 19. First database query

Let's prove we're actually executing SQL.

Open psql:
```

docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```

Run:
```

SELECT NOW();

```

You'll get something like:

```

              now
-------------------------------
2026-09-21 12:...

```

Then:

```

SELECT 1 + 1;

```

Expected:
```
2
```

Exit:

```

\q

```

---

### 20. Create our first table

Now we're ready for our actual domain.

We'll create an `incidents table.`

Inside psql:

```

CREATE TABLE incidents (
    id UUID PRIMARY KEY,
    service VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

```

Check:

```
\d incidents

```

You should see:


```
id
service
severity
status
created_at
updated_at

```

Note - Execute this query inside pg admin 


---


### 21. Why UUID?

We're using:
```
id UUID PRIMARY KEY
```

rather than:
```

id SERIAL

```

because this platform will eventually become distributed.

For example:

```

API instance 1
API instance 2
Worker 1
Worker 2
Worker 3

```

A UUID can be generated independently without requiring a central counter.

Example:

```

550e8400-e29b-41d4-a716-446655440000

```

We'll go deeper into ID generation and distributed-system implications later.

---

### 22. Incident status

Currently:

```

status VARCHAR(20)

```

We'll eventually have:


```

detected
investigating
acknowledged
mitigating
resolved
closed

```

For now, we're keeping the database simple.

Later we'll discuss whether this should be:

```

VARCHAR
ENUM
lookup table
domain type

```

and why.


---


### 23. Incident severity

Similarly:

```
low
medium
high
critical

```

We intentionally haven't created a PostgreSQL` ENUM` yet.

Why?

Because we're still designing the domain.

Prematurely encoding every business rule into the database can make future migrations harder.

We'll revisit this after we've modeled the domain properly.


---

### 24. Verify the table

Run:

```

SELECT * FROM incidents;

```

Expected:

```

 id | service | severity | status | created_at | updated_at
----+---------+----------+--------+------------+------------
(0 rows)

```

That's correct.

The table exists, but we haven't inserted anything.

---

### 25. Current architecture

We now have:

```
                         HTTP
                          │
                          ▼
                     Express API
                          │
                          ▼
                      Controller
                          │
                          ▼
                    Database Module
                          │
                          ▼
                    Connection Pool
                          │
                          ▼
                    PostgreSQL
                          │
                          ▼
                      incidents
```

Infrastructure:

```
Docker Compose
      │
      ▼
PostgreSQL 17
      │
      ▼
Persistent Volume

```

---

### Lecture 7 checkpoint

At this point we have crossed an important boundary:

```
             BEFORE
                │
                ▼
       In-memory Express
                │
                │
           Lecture 7
                │
                ▼
             AFTER
                │
       ┌────────┴────────┐
       ▼                 ▼
   Express API      PostgreSQL
                         │
                    incidents
```


We still haven't added an ORM.

We still haven't added Redis.

We still haven't added BullMQ.

That's deliberate.


---



