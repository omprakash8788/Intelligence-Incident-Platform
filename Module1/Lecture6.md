### Lecture 6 — Production Configuration & Environment Management.


We're now going to make the application behave like a real production service.

Currently we have things like:

```
const PORT = 3000;
```

That works locally, but production systems should not hardcode infrastructure configuration.

We want:

```
.env
  ↓
Environment Variables
  ↓
Configuration Module
  ↓
Application
```

And we'll make configuration **validated at startup.**

---

### 1. Why configuration matters

Eventually our application will need:

```

PORT
NODE_ENV

POSTGRES_HOST
POSTGRES_PORT
POSTGRES_DATABASE
POSTGRES_USER
POSTGRES_PASSWORD

REDIS_HOST
REDIS_PORT

```

We don't want this:

```

const postgresHost = "localhost";
const postgresPassword = "password123";

```

inside application code.

Instead:

```

Development
    ↓
localhost

Docker
    ↓
postgres container

Production
    ↓
production database

```

The application code should remain the same.

Only configuration changes.

---

### 2. Install dotenv

We'll use `dotenv` to load `.env.`

```
npm install dotenv
```

---

### 3. Create .env

At the project root:

```
production-intelligence-platform/
├── src/
├── tests/
├── .env
├── package.json
└── tsconfig.json
```

Create:
```
.env

```

Add:

```
NODE_ENV=development
PORT=3000

```

---

### 4. Never commit .env

Create:
```
.gitignore

```

Add:

```
node_modules/
dist/
.env
coverage/

```

This is extremely important.

Never put:

```

POSTGRES_PASSWORD=real-password

```

into Git.

---

### 5. Create configuration module

Create:
```
src/config/env.ts
```

```
import "dotenv/config";

const port = Number(process.env.PORT);

if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT must be a positive integer");
}

const nodeEnv = process.env.NODE_ENV ?? "development";

const allowedEnvironments = [
  "development",
  "test",
  "production"
];

if (!allowedEnvironments.includes(nodeEnv)) {
  throw new Error(
    `Invalid NODE_ENV: ${nodeEnv}`
  );
}

export const env = {
  nodeEnv,
  port
} as const;
```

---

### 6. Why validate environment variables?

Consider:
```
PORT=hello
```

Without validation:
```
Number(process.env.PORT)
```
becomes:
```
NaN
```
You don't want the application discovering this after several requests.

We want:
```
Application starts
      ↓
Validate configuration
      ↓
Invalid?
      ↓
STOP IMMEDIATELY
```

This is called **fail fast.**

---

### 7. Update server.ts

Currently:
```
const PORT = 3000;
```
Remove it.

Use our configuration:
```
import app from "./app.js";
import { env } from "./config/env.js";

app.listen(env.port, () => {
  console.log(
    `Server running on port ${env.port}`
  );
});

```
Now the application doesn't care whether the port is:
```
3000
```
or:
```
8080
```
or:
```
5000
```
It comes from configuration.

---

### 8. Test it

Run:
```
npm run dev
```
You should see:
```
Server running on port 3000
```
Now change .env:
```
NODE_ENV=development
PORT=4000
```

Restart:
```
npm run dev
```
Now:
```
Server running on port 4000
```
No code change required.

That's exactly what we want.

---


### 9. Add PostgreSQL configuration now

We're not connecting to PostgreSQL yet.

But we'll define its configuration now because the next phase will introduce it.

Change `.env:`
```
NODE_ENV=development
PORT=3000

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

```

These are development values.

**Don't use real production credentials here.**

---

### 10. Extend env.ts

Now:

```
import "dotenv/config";

const port = Number(process.env.PORT);
const postgresPort = Number(process.env.POSTGRES_PORT);

const nodeEnv = process.env.NODE_ENV ?? "development";

const allowedEnvironments = [
  "development",
  "test",
  "production"
];

if (!allowedEnvironments.includes(nodeEnv)) {
  throw new Error(
    `Invalid NODE_ENV: ${nodeEnv}`
  );
}

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(
    "PORT must be a positive integer"
  );
}

if (
  !Number.isInteger(postgresPort) ||
  postgresPort <= 0
) {
  throw new Error(
    "POSTGRES_PORT must be a positive integer"
  );
}

const required = {
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
  POSTGRES_USER: process.env.POSTGRES_USER,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD
};

for (const [key, value] of Object.entries(required)) {
  if (!value) {
    throw new Error(
      `${key} environment variable is required`
    );
  }
}

export const env = {
  nodeEnv,
  port,

  postgres: {
    host: required.POSTGRES_HOST,
    port: postgresPort,
    database: required.POSTGRES_DATABASE,
    user: required.POSTGRES_USER,
    password: required.POSTGRES_PASSWORD
  }
} as const;
```

---

### 11. Important: TypeScript inference

Because of our checks:
```
if (!value) {
  throw new Error(...);
}

```

TypeScript can understand that the values we export are strings.

So:
```

env.postgres.host
```

is treated as:
```
string
```

rather than:
```
string | undefined
```

This is much cleaner for the rest of the application.

---

### 12. Test configuration failure

Now let's intentionally break it.

Change:
```
POSTGRES_PORT=5432
```

to:
```
POSTGRES_PORT=hello`
```

Run:
```
npm run dev
```

The application should fail during startup.

You'll see an error similar to:
```
Error: POSTGRES_PORT must be a positive integer
```
That's good.

We don't want the application running with invalid infrastructure configuration.

Restore:
```

POSTGRES_PORT=5432

```

---

### 13. Another failure test

Delete:
```
POSTGRES_PASSWORD=postgres
```

Run:
```
npm run dev
```

Expected:
```
Error: POSTGRES_PASSWORD environment variable is required
```

Restore it afterward.

---

### 14. Why fail fast?

Imagine production:
```
Server starts
      ↓
Requests arrive
      ↓
User creates incident
      ↓
Service tries PostgreSQL
      ↓
Database configuration invalid
      ↓
Request fails

```

That's terrible.

Instead:

```

Server starts
      ↓
Configuration validation
      ↓
INVALID
      ↓
Application DOES NOT START

```

The problem is discovered immediately.

---

### 15. Configuration architecture

Our structure is becoming:
```
src/
│
├── config/
│   └── env.ts
│
├── controllers/
├── routes/
├── validators/
├── middleware/
├── errors/
│
├── app.ts
└── server.ts

```

And the startup flow:

```
.env
 │
 ▼
dotenv
 │
 ▼
env.ts
 │
 ├── validate NODE_ENV
 ├── validate PORT
 ├── validate PostgreSQL
 │
 ▼
export env
 │
 ▼
server.ts
 │
 ▼
application
```

---

### 16. One important rule

From now on, **don't access** `process.env` **throughout the application.**

Avoid:
```
const host = process.env.POSTGRES_HOST;
```

inside random files.

Instead:
```
import { env } from "../config/env.js";

console.log(env.postgres.host);
```

This gives us a single configuration boundary.

Later:
```
Database
Redis
Queues
WebSockets
External services
```

can all consume the same configuration module.

---

### 17. Test configuration indirectly

We don't need a huge test suite for env.ts yet.

Our immediate verification is:
```
npm run build
```

Then:
```
npm run test:run
```

And:
```
npm run dev
```

All should work with valid` .env.`

---

### Lecture 6 checkpoint

Run these in order:

### 1. Build
```
npm run build
```

Expected:
```
successful TypeScript compilation
```
### 2. Tests
```
npm run test:run
```

Expected:
```
0 failed
```
### 3. Start
```
npm run dev
```

Expected:
```
Server running on port 3000
```
### 4. Health
```
GET /health
```

Expected:
```
{
  "status": "ok",
  "service": "production-intelligence-platform"
}
```

---


### What you learned

The important concepts from this lecture are:

### Configuration separation
```
Code ≠ Environment
```
### Fail-fast startup
```
Invalid configuration
        ↓
Application doesn't start
```

### Secret isolation
```
.env
 ↓
.gitignore
 ↓
Never commit secrets
```

### Single configuration boundary
```
process.env
     ↓
  env.ts
     ↓
Application

```

---


