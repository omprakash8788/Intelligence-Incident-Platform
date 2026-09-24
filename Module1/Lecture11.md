### Module 1 — Lecture 11
### Database Migrations — Version-Controlled Database

Now we move to ***database migrations***.

Until Lecture 10, we created our PostgreSQL tables manually with SQL such as:

```
CREATE TABLE incidents (...);
```

That is fine while learning PostgreSQL, but it is `not a production-grade workflow`.

Our application needs to know:

`Which database schema version am I running?`

And another developer should be able to clone the project and run one command to create the correct database.

### 1. The problem with manual SQL

Imagine today we have:
```
incidents
incident_events
```
Tomorrow we need:
```
incident_events
    ↓
add metadata column
```
Then later:
```
incidents
    ↓
add acknowledged_at
```
If we manually modify the database:
```
ALTER TABLE incidents ...
```
we have no reliable history.

We want:
```
Migration 001
     ↓
Migration 002
     ↓
Migration 003
     ↓
Migration 004
```
The database can then tell us:
```
I have executed migrations:
001
002
003
```

### 2. Migration principle

A migration should generally be:

`Small, ordered, reproducible, and version-controlled.`

For example:
```
database/
└── migrations/
    ├── 001_create_incidents.sql
    ├── 002_create_incident_events.sql
    └── 003_add_incident_indexes.sql
```
The numbers determine execution order.

### 3. Create migration directory

Inside the project:
```
src/
database/
```
We're going to create:
```
database/
└── migrations/
```
Your project becomes:

```
src/
├── config/
├── controllers/
├── database/
│   ├── migrations/
│   ├── health.ts
│   ├── pool.ts
│   └── transaction.ts
├── domain/
├── errors/
├── middleware/
├── repositories/
├── routes/
├── services/
└── ...
```

### 4. First migration

Create:
```
src/database/migrations/001_create_incidents.sql
```
Put:
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

### 5. Second migration

Create:
```
src/database/migrations/002_create_incident_events.sql
```
```
CREATE TABLE incident_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id),
    event_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Notice the dependency:
```
incidents
   ↑
   │
incident_events
```
Therefore:

```
001 must execute before 002
```


### 6. Third migration — indexes

Create:
```
src/database/migrations/003_add_incident_indexes.sql
```
For now:
```
CREATE INDEX idx_incidents_service
ON incidents(service);

CREATE INDEX idx_incidents_status
ON incidents(status);

CREATE INDEX idx_incident_events_incident_id
ON incident_events(incident_id);
```
Why?

Our future system will frequently ask things like:
```
SELECT *
FROM incidents
WHERE service = 'payment-service';
```
and:
```
SELECT *
FROM incidents
WHERE status = 'investigating';
```
Indexes will become very important when the incident table becomes large.

`We will study indexes deeply in Lecture 13.`

For now we're only establishing migration discipline.

### 7. Important problem: your database already has these tables

You already created:
```
incidents
incident_events
```
manually.

Therefore, if we simply execute:
```
001_create_incidents.sql
```
PostgreSQL will say:
```
ERROR: relation "incidents" already exists
```
We need to decide how to handle this.

Because this is a learning/development database, I recommend resetting it.

### 8. Reset the development database

⚠️ This deletes the current development data.

First enter PostgreSQL:
```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```
Then:
```
DROP TABLE IF EXISTS incident_events;
DROP TABLE IF EXISTS incidents;
```
Verify:
```
\dt
```
You should no longer see:
```
incidents
incident_events
```
Exit:
```
\q
```

### 9. But migrations need a migration table

Our application needs to remember:

Which migrations have already executed?

Create a special table:
```
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
This table might contain:
```
version
-----------------------------
001_create_incidents
002_create_incident_events
003_add_incident_indexes
```
The database now has its own schema history.

### 10. We should automate this

We don't want developers manually running:
```
001...
002...
003...
```
Instead:
```
npm run migrate
```
should do everything.

The migration system should:

```
Read migration files
       ↓
Sort them
       ↓
Check schema_migrations
       ↓
Find pending migrations
       ↓
Execute pending migrations
       ↓
Record successful migration
```
### 11. Install migration dependency

We're going to keep the implementation simple and use Node's filesystem APIs rather than introducing a large migration framework.

You already have:
```
pg
typescript
tsx
```
So we don't need another package.

This is intentional.

I want you to understand how migrations actually work.

### 12. Create migration runner

Create:
```
src/database/migrate.ts
```
Start with:
```
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationsDirectory =
  path.join(__dirname, "migrations");

const runMigrations = async () => {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = await fs.readdir(
      migrationsDirectory
    );

    const migrationFiles = files
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const result = await client.query(`
      SELECT version
      FROM schema_migrations
    `);

    const appliedMigrations =
      new Set(
        result.rows.map(
          (row) => row.version
        )
      );

    for (const file of migrationFiles) {

      const version = file.replace(
        ".sql",
        ""
      );

      if (appliedMigrations.has(version)) {
        continue;
      }

      console.log(
        `Running migration: ${version}`
      );

      const sql = await fs.readFile(
        path.join(
          migrationsDirectory,
          file
        ),
        "utf-8"
      );

      await client.query("BEGIN");

      try {
        await client.query(sql);

        await client.query(
          `
            INSERT INTO schema_migrations (
              version
            )
            VALUES ($1)
          `,
          [version]
        );

        await client.query("COMMIT");

        console.log(
          `Migration completed: ${version}`
        );

      } catch (error) {

        await client.query("ROLLBACK");

        throw error;
      }
    }

    console.log(
      "Database migrations completed."
    );

  } finally {
    client.release();
    await pool.end();
  }
};

runMigrations().catch((error) => {
  console.error(
    "Migration failed:",
    error
  );

  process.exit(1);
});
```
### 13. Why use a transaction for each migration?

This is extremely important.

Imagine migration:
```
CREATE TABLE incidents (...);

CREATE TABLE incident_events (...);

CREATE INDEX ...;
```
Suppose:
```
CREATE TABLE incidents
       ↓
SUCCESS

CREATE TABLE incident_events
       ↓
SUCCESS

CREATE INDEX
       ↓
FAIL
```
Without a transaction, we could end up with:
```
incidents           ✅
incident_events     ✅
index               ❌
```
The migration partially executed.

That's dangerous.

With:
```
BEGIN;

migration;

INSERT INTO schema_migrations;

COMMIT;
```
if anything fails:
```
ROLLBACK;
```
Everything from that migration is undone.

So:
```
Migration
   ↓
BEGIN
   ↓
Execute
   ↓
Success?
  /   \
YES    NO
 ↓      ↓
COMMIT ROLLBACK
```
This is the same transaction principle we learned in Lecture 9.


### 14. Add npm script

Open:
```
package.json
```
Add:
```
"migrate": "tsx src/database/migrate.ts"
```
Your scripts should now look approximately like:
```
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest",
    "test:run": "vitest run",
    "migrate": "tsx src/database/migrate.ts"
  }
}
```
### 15. Run migrations

Make sure PostgreSQL is running:
```
docker compose up -d postgres
```
Then:
```
npm run migrate
```
You should see something similar to:
```
Running migration: 001_create_incidents
Migration completed: 001_create_incidents

Running migration: 002_create_incident_events
Migration completed: 002_create_incident_events

Running migration: 003_add_incident_indexes
Migration completed: 003_add_incident_indexes
```
Database migrations completed.

### 16. Verify the database

Enter PostgreSQL:
```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```
Run:
```
\dt
```
You should see:
```
incidents
incident_events
schema_migrations
```
Now:
```
SELECT *
FROM schema_migrations
ORDER BY version;
```
Expected:
```
001_create_incidents
002_create_incident_events
003_add_incident_indexes
```
### 17. Test idempotency

This is one of the most important tests.

Run:
```
npm run migrate
```
again.

You should NOT see:
```
Running migration: 001...
Running migration: 002...
Running migration: 003...
```
Instead:

Database migrations completed.

Why?

Because:
```
if (appliedMigrations.has(version)) {
  continue;
}
```

The migration runner knows they already executed.

This property is called `idempotent migration execution`.

### 18. Now add Migration 004

Let's prove the system actually works.

Create:
```
src/database/migrations/004_add_incident_acknowledged_at.sql
```
Add:
```
ALTER TABLE incidents
ADD COLUMN acknowledged_at TIMESTAMPTZ;
```
Now run:
```
npm run migrate
```
Expected:
```
Running migration: 004_add_incident_acknowledged_at
Migration completed: 004_add_incident_acknowledged_at
```
Check:
```
\d incidents
```
You should now see:
```
acknowledged_at
```

### 19. This is the workflow we want

From now on, never manually modify the production schema.

Instead:

```
Need database change
        ↓
Create migration
        ↓
001 / 002 / 003 / ...
        ↓
Commit migration to Git
        ↓
Deploy
        ↓
Run migrations
        ↓
Database updated
```
Example:

005_add_incident_resolved_at.sql
006_add_incident_priority.sql
007_add_incident_source.sql

The migration history becomes part of the codebase.

### 20. One important production rule

Never edit an already-applied migration.

For example, suppose:
```
003_add_incident_indexes.sql
```
has already run.

Don't modify it from:
```
CREATE INDEX ...
```
to something else.

Instead create:
```
005_modify_incident_indexes.sql
```
Why?

Because another environment may already have executed the old migration.

Migration history should be treated as immutable.

### 21. Current architecture

After Lecture 11:

```
Production Intelligence Platform
│
├── API
│   ├── Controllers
│   ├── Routes
│   ├── Middleware
│   └── Validation
│
├── Business
│   ├── Services
│   └── Domain
│
├── Persistence
│   ├── Repositories
│   └── PostgreSQL
│
├── Database
│   ├── Pool
│   ├── Transactions
│   ├── Health
│   └── Migrations
│
└── Tests
    ├── Unit
    ├── API
    └── Integration
    
```

We're starting to build something that resembles a real backend rather than just an Express CRUD application.

### 22. Your checkpoint — DO NOT SKIP

Run these in order:

#### Step 1
```
docker compose up -d postgres
```
#### Step 2
```
npm run build
```
#### Step 3
```
npm run migrate
```

 #### Step 4
 ```
npm run migrate
```
The second execution is important.

 #### Step 5
 ```
npm run test:run
```
 #### Step 6

Verify:

```
docker exec -it production-intelligence-postgres psql -U postgres -d production_intelligence
```
Then:
```
FROM schema_migrations
ORDER BY version;
```
And:
```
\d incidents
```
