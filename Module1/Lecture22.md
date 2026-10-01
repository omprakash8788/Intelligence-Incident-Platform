# Production Intelligence & Incident Platform

# Module 1 — Lecture 22: Configuration Hardening

> **Goal:** Turn our current environment configuration into a production-grade, strongly validated, fail-fast configuration system.

---

## Table of Contents

1. [Lecture Objective](#1-lecture-objective)
2. [Why Configuration Hardening Matters](#2-why-configuration-hardening-matters)
3. [Current Problem](#3-current-problem)
4. [Target Architecture](#4-target-architecture)
5. [Step 1 — Configuration Principles](#5-step-1--configuration-principles)
6. [Step 2 — Create Configuration Types](#6-step-2--create-configuration-types)
7. [Step 3 — Harden Environment Validation](#7-step-3--harden-environment-validation)
8. [Step 4 — Separate Required and Optional Configuration](#8-step-4--separate-required-and-optional-configuration)
9. [Step 5 — Add Application Configuration](#9-step-5--add-application-configuration)
10. [Step 6 — Update Database Configuration](#10-step-6--update-database-configuration)
11. [Step 7 — Add Test Environment Configuration](#11-step-7--add-test-environment-configuration)
12. [Step 8 — Update `.env.example`](#12-step-8--update-envexample)
13. [Step 9 — Verify Application Startup](#13-step-9--verify-application-startup)
14. [Step 10 — Configuration Unit Tests](#14-step-10--configuration-unit-tests)
15. [Step 11 — Intentional Break Test](#15-step-11--intentional-break-test)
16. [Step 12 — Fix the Broken Configuration](#16-step-12--fix-the-broken-configuration)
17. [Step 13 — Production Configuration Rules](#17-step-13--production-configuration-rules)
18. [Step 14 — Security Rules](#18-step-14--security-rules)
19. [Step 15 — Build and Test](#19-step-15--build-and-test)
20. [Step 16 — Final Verification](#20-step-16--final-verification)
21. [Final Architecture](#21-final-architecture)
22. [Final Folder Structure](#22-final-folder-structure)
23. [What We Learned](#23-what-we-learned)
24. [Success Criteria](#24-success-criteria)
25. [Next Lecture](#25-next-lecture)

---

# 1. Lecture Objective

Our application currently reads environment variables directly inside:

```text
src/config/env.ts
```
This works, but production systems need stronger guarantees.

We want configuration to behave like this:
```
Application starts
       │
       ▼
Load environment variables
       │
       ▼
Validate every required value
       │
       ├── invalid ──► FAIL FAST
       │
       ▼
Convert strings → correct types
       │
       ▼
Apply safe defaults
       │
       ▼
Create immutable application configuration
       │
       ▼
Application starts
```
The important principle is:

**If configuration is invalid, the application should fail during startup rather than discovering the problem during a request.**

---

### 2. Why Configuration Hardening Matters

Environment variables are always strings.

For example:
```
PORT=3000
```
Node receives:
```
process.env.PORT
```
as:
```
"3000"
```
not:
```
3000
```
That means this:
```
process.env.PORT + 1
```
produces:
```
30001
```
instead of:
```
3001
```
Configuration therefore needs:

- Validation
- Type conversion
- Defaults
- Environment-specific behavior
- Secret protection
- Fail-fast startup
- Testability

---

### 3. Current Problem

Our current configuration is already better than directly using:
```
process.env.PORT
```
everywhere.

However, we can improve it.

Current architecture:
```
process.env
    │
    ▼
src/config/env.ts
    │
    ▼
env.port
env.postgres.host
env.postgres.port
...
```
We now want:
```
process.env
    │
    ▼
Environment validation
    │
    ▼
Type conversion
    │
    ▼
Configuration object
    │
    ├── application
    ├── postgres
    └── security
         │
         ▼
      Application
```
This gives us one source of truth.

---

### 4. Target Architecture

The configuration module will become the boundary between:
```
External Environment
```
and:
```
Internal Application
```
Architecture:
```
┌───────────────────────────────┐
│         Environment           │
│                               │
│ NODE_ENV                      │
│ PORT                          │
│ POSTGRES_HOST                 │
│ POSTGRES_PORT                 │
│ POSTGRES_DATABASE             │
│ POSTGRES_USER                 │
│ POSTGRES_PASSWORD             │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│      Configuration Layer      │
│                               │
│ validation                    │
│ parsing                       │
│ defaults                      │
│ normalization                 │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│      Typed Configuration      │
│                               │
│ env.nodeEnv                   │
│ env.app.port                  │
│ env.postgres.port             │
│ env.postgres.database         │
│ ...                           │
└───────────────┬───────────────┘
                │
                ▼
        Application Services
```

---

### 5. Step 1 — Configuration Principles

We will follow these rules.

#### Rule 1 — Never access process.env throughout the application

Bad:
```
const port = Number(process.env.PORT);
```
inside random files.

Good:
```
import { env } from "./config/env.js";

env.app.port
```

---


#### Rule 2 — Validate once

Configuration should be validated during startup.

Not:
```
Request 1 → discover missing variable
Request 2 → discover another problem
Request 3 → discover another problem
```
Instead:
```
Application startup
       │
       ▼
Configuration validation
       │
       ▼
Everything valid
       │
       ▼
Application starts
```

---

#### Rule 3 — Convert types at the boundary

Environment:
```
PORT=3000
```
Application:
```
env.app.port
```
should already be:
```
number
```

---

#### Rule 4 — Never log secrets

Never:
```
logger.info("Configuration", {
  password: env.postgres.password
});
```
Never log:
```
POSTGRES_PASSWORD
DATABASE_URL
API_KEY
JWT_SECRET
```

---

### 6. Step 2 — Create Configuration Types

We will create a dedicated type definition.

#### File: *src/config/config.types.ts*

Create this file:
```
export type NodeEnvironment =
  | "development"
  | "test"
  | "production";

export interface ApplicationConfig {
  nodeEnv: NodeEnvironment;
  port: number;
}

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface SecurityConfig {
  requestBodyLimit: string;
}

export interface AppConfig {
  app: ApplicationConfig;
  postgres: PostgresConfig;
  security: SecurityConfig;
}
```

---

### 7. Step 3 — Harden Environment Validation

Now replace the existing configuration implementation.

#### File: *src/config/env.ts*

**Replace the complete file with:**
```
import "dotenv/config";

import type {
  AppConfig,
  NodeEnvironment
} from "./config.types.js";

const parseRequiredString = (
  name: string
): string => {

  const value =
    process.env[name];

  if (
    value === undefined ||
    value.trim() === ""
  ) {
    throw new Error(
      `${name} environment variable is required`
    );
  }

  return value.trim();
};

const parsePositiveInteger = (
  name: string,
  value: string
): number => {

  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer`
    );
  }

  return parsed;
};

const parseEnvironment = (): NodeEnvironment => {

  const value =
    process.env.NODE_ENV ??
    "development";

  const allowed:
    NodeEnvironment[] = [
      "development",
      "test",
      "production"
    ];

  if (
    !allowed.includes(
      value as NodeEnvironment
    )
  ) {
    throw new Error(
      `Invalid NODE_ENV: ${value}`
    );
  }

  return value as NodeEnvironment;
};

const nodeEnv =
  parseEnvironment();

const port =
  parsePositiveInteger(
    "PORT",
    process.env.PORT ?? "3000"
  );

const postgresPort =
  parsePositiveInteger(
    "POSTGRES_PORT",
    process.env.POSTGRES_PORT ??
      "5432"
  );

const postgresHost =
  parseRequiredString(
    "POSTGRES_HOST"
  );

const postgresDatabase =
  parseRequiredString(
    "POSTGRES_DATABASE"
  );

const postgresUser =
  parseRequiredString(
    "POSTGRES_USER"
  );

const postgresPassword =
  parseRequiredString(
    "POSTGRES_PASSWORD"
  );

export const env: AppConfig = {
  app: {
    nodeEnv,
    port
  },

  postgres: {
    host:
      postgresHost,
    port:
      postgresPort,
    database:
      postgresDatabase,
    user:
      postgresUser,
    password:
      postgresPassword
  },

  security: {
    requestBodyLimit:
      "100kb"
  }
};
```

---

### 8. Step 4 — Separate Required and Optional Configuration

Notice this:
```
const port =
  parsePositiveInteger(
    "PORT",
    process.env.PORT ?? "3000"
  );
```
This means:
```
PORT missing
     │
     ▼
3000
```
We intentionally consider *PORT* optional.

But:
```
const postgresHost =
  parseRequiredString(
    "POSTGRES_HOST"
  );
```
means:
```
POSTGRES_HOST missing
        │
        ▼
Application startup fails
```
This distinction is important.

---

#### Required Configuration

Currently:
```
POSTGRES_HOST
POSTGRES_DATABASE
POSTGRES_USER
POSTGRES_PASSWORD
```
are required.

---

#### Optional Configuration

Currently:
```
NODE_ENV
PORT
POSTGRES_PORT
```
have safe defaults.

Defaults:
```
NODE_ENV       → development
PORT           → 3000
POSTGRES_PORT  → 5432
```

---

### 9. Step 5 — Add Application Configuration

We have changed:
```
env.port
```
to:
```
env.app.port
```
Therefore we must update the application entry point.

#### File: *src/server.ts*

**Replace the complete file with:**

```
import { createServer } from "node:http";

import app from "./app.js";

import { env } from "./config/env.js";

import {
  logger
} from "./logging/logger.js";

import {
  markApplicationReady
} from "./server/lifecycle.js";

import {
  shutdown
} from "./server/shutdown.js";

const server =
  createServer(app);

server.listen(
  env.app.port,
  () => {

    markApplicationReady();

    logger.info(
      "Server started",
      {
        port:
          env.app.port,
        environment:
          env.app.nodeEnv
      }
    );
  }
);

const handleShutdown =
  (signal: string) => {

    void shutdown(
      server,
      signal
    );
  };

process.on(
  "SIGINT",
  () => {
    handleShutdown("SIGINT");
  }
);

process.on(
  "SIGTERM",
  () => {
    handleShutdown("SIGTERM");
  }
);
```

---

### 10. Step 6 — Update Database Configuration

Our database pool currently uses:
```
env.postgres.host
env.postgres.port
```
Those properties remain the same.

Therefore the database configuration does not need structural changes.

#### File: *src/database/pool.ts*

Verify it contains:
```
import { Pool } from "pg";

import { env } from "../config/env.js";

export const pool =
  new Pool({
    host:
      env.postgres.host,

    port:
      env.postgres.port,

    database:
      env.postgres.database,

    user:
      env.postgres.user,

    password:
      env.postgres.password,

    max: 10,

    idleTimeoutMillis:
      30_000,

    connectionTimeoutMillis:
      5_000
  });
```

---

### 11. Step 7 — Add Test Environment Configuration

We want tests to be explicitly identifiable.

Our configuration already supports:
```
development
test
production
```
Create a dedicated test environment file.

#### File: *.env.test*

**Create this file:**
```
NODE_ENV=test
PORT=3001

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
```
Do not commit real credentials.

For this local learning project, these are development/test credentials only.

---

### 12. Step 8 — Update .env.example
#### File: *.env.example*

Replace the complete file with:
```
# Application
NODE_ENV=development
PORT=3000

# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=production_intelligence
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
```
The example file documents what the application expects.

---

### 13. Step 9 — Verify .gitignore
#### File: *.gitignore*

Verify that these entries exist:
```
node_modules/
dist/
.env
.env.test
coverage/
```
The important addition is:
```
.env.test
```

---

### 14. Step 10 — Configuration Unit Tests

We need to test configuration behavior.

There is one complication:
```
env.ts
```
executes configuration validation when imported.

That is actually desirable for production startup, but testing different environment values requires controlling the environment before importing the module.

For this lecture, we will first test the exported configuration contract.

#### File: *tests/config/env.test.ts*

**Create this file:**

```
import {
  describe,
  expect,
  it
} from "vitest";

import { env } from "../../src/config/env.js";

describe(
  "environment configuration",
  () => {

    it(
      "should expose a valid application configuration",
      () => {

        expect(
          env.app.nodeEnv
        ).toMatch(
          /^(development|test|production)$/
        );

        expect(
          env.app.port
        ).toBeGreaterThan(0);
      }
    );

    it(
      "should expose a valid PostgreSQL configuration",
      () => {

        expect(
          env.postgres.host
        ).toBeTruthy();

        expect(
          env.postgres.port
        ).toBeGreaterThan(0);

        expect(
          env.postgres.database
        ).toBeTruthy();

        expect(
          env.postgres.user
        ).toBeTruthy();

        expect(
          env.postgres.password
        ).toBeTruthy();
      }
    );

    it(
      "should expose security configuration",
      () => {

        expect(
          env.security.requestBodyLimit
        ).toBe("100kb");
      }
    );
  }
);
```

---


### 15. Step 11 — Intentional Break Test

Now we intentionally break configuration.

This is part of our learning method:
```
BUILD
  ↓
TEST
  ↓
BREAK
  ↓
OBSERVE
  ↓
FIX
  ↓
TEST AGAIN
```

---

#### Break #1 — Invalid Port
#### File: .env

Temporarily change:
```
PORT=3000
```
to:
```
PORT=hello
```
Now run:
```
npm run dev
```
Expected result:
```
PORT must be a positive integer
```
The server should **not start**.

This is exactly what we want.

---

### 16. Step 12 — Fix the Broken Configuration

Change:

#### File: .env

Back to:
```
PORT=3000
```
Run:
```
npm run dev
```
Expected:
```
Server started
```
with:
```
port: 3000
```

---

### 17. Step 13 — More Intentional Break Tests

Now test missing required configuration.

#### Break #2 — Missing PostgreSQL Host
#### File: .env

Temporarily change:
```
POSTGRES_HOST=localhost
```
to:
```
POSTGRES_HOST=
```
Run:
```
npm run dev
```
Expected:
```
POSTGRES_HOST environment variable is required
```
The server must not start.
Restore:
```
POSTGRES_HOST=localhost
```

---

### 18. Intentional Break #3 — Invalid PostgreSQL Port
#### File: .env

Temporarily change:
```
POSTGRES_PORT=5432
```
to:
```
POSTGRES_PORT=-1
```
Run:
```
npm run dev
```
Expected:
```
POSTGRES_PORT must be a positive integer
```
Restore:
```
POSTGRES_PORT=5432
```

---

### 19. Intentional Break #4 — Invalid Environment
#### File: .env

Temporarily change:
```
NODE_ENV=development
```
to:
```
NODE_ENV=something
```
Run:
```
npm run dev
```
Expected:
```
Invalid NODE_ENV: something
```
Restore:
```
NODE_ENV=development
```
---

### 20. Step 14 — Build the Application

Run:
```
npm run build
```
Expected:
```
tsc
```
with no TypeScript errors.

If TypeScript reports:
```
Property 'port' does not exist...
```
search the project for:
```
env.port
```
and change it to:
```
env.app.port
```
PowerShell:
```
Get-ChildItem -Recurse -Include *.ts |
  Select-String "env\.port"

```

---

### 21. Step 15 — Run Tests

Run:
```
npm run test:run
```
Expected:
```
Test Files  ... passed
Tests       ... passed
```
All existing tests must continue passing.

This is important.

Configuration changes should not silently break unrelated modules.

---

### 22. Step 16 — Verify the Server

Start PostgreSQL:
```
docker compose up -d postgres
```
Check:
```
docker compose ps
```
Then:
```
npm run dev
```
Expected log:
```
Server started
```

---

### 23. Verify Health Endpoint

Open another PowerShell terminal.

Run:
```
Invoke-WebRequest http://localhost:3000/health/live
```
Expected HTTP status:
```
200
```
---

### 24. Verify Readiness

Run:
```
Invoke-WebRequest http://localhost:3000/health/ready
```
Expected:
```
200
```
because:
```
Application = READY
PostgreSQL = AVAILABLE
```

---

### 25. Configuration Fail-Fast Demonstration

The important production behavior is:
```
Invalid configuration
       │
       ▼
Application does NOT start
       │
       ▼
Problem immediately visible
```
Instead of:
```
Application starts
       │
       ▼
Request arrives
       │
       ▼
Database connection fails
       │
       ▼
500 error
```
The first approach is much safer.

---

### 26. Step 17 — Configuration Security

There are several rules we must follow.

#### Never commit .env

Correct:
```
.env
```
#### Never commit production secrets

Never put:
```
real database password
JWT secret
AWS secret
API key
private key
```
into:
```
.env.example
```
Use placeholders:
```
POSTGRES_PASSWORD=change-me
```

---

### 27. Never Log Secrets

Bad:
```
logger.info(
  "Database configuration",
  {
    host: env.postgres.host,
    user: env.postgres.user,
    password: env.postgres.password
  }
);
```
This exposes credentials.

Good:
```
logger.info(
  "Database configuration loaded",
  {
    host: env.postgres.host,
    port: env.postgres.port,
    database: env.postgres.database
  }
);
```
Even then, avoid logging more configuration than necessary.

---

### 28. Configuration vs Secrets

This distinction becomes important as the project grows.

Configuration:
```
PORT
NODE_ENV
POSTGRES_HOST
POSTGRES_PORT
```
Secrets:
```
POSTGRES_PASSWORD
JWT_SECRET
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```
Configuration can often be safely documented.

Secrets should be supplied by a secure secret-management mechanism in production.

For our local project:
```
.env
```
is acceptable.

Later, when we deploy:
```
Docker secrets
AWS Secrets Manager
Kubernetes Secrets
```
or another appropriate secret-management mechanism can be considered.

---

### 29. Production Configuration Model

Our application now has three supported environments:
```
development
test
production
```
Conceptually:
```
┌───────────────┐
│ Development   │
│               │
│ local Docker  │
│ local DB      │
└───────────────┘

┌───────────────┐
│ Test          │
│               │
│ isolated test │
│ configuration │
└───────────────┘

┌───────────────┐
│ Production    │
│               │
│ real infra    │
│ real secrets  │
└───────────────┘
```
The application code should remain the same.
Only configuration should change.

---

### 30. Configuration Boundary Principle

A very important architectural principle:

**The rest of the application should not care where configuration came from.**

It should only know:
```
env.app.port
```
or:
```
env.postgres.host
```
It should not care whether the value came from:
```
.env
Docker
AWS
Kubernetes
CI/CD
environment variables
```
That is the responsibility of the configuration layer.

---

### 31. Why We Don't Add a Configuration Library Yet

There are libraries such as:
```
zod
envalid
convict
dotenv-safe
```
They can be useful.

But for this lecture, we intentionally implement the configuration boundary ourselves.

Why?

Because you need to understand:
```
string input
     ↓
validation
     ↓
normalization
     ↓
type conversion
     ↓
typed configuration
```
Once that concept is understood, a validation library becomes a tool rather than magic.

---

### 32. Configuration Architecture After Lecture 22
```
process.env
     │
     ▼
┌──────────────────────┐
│ src/config/env.ts    │
│                      │
│ parse                │
│ validate             │
│ normalize            │
│ convert               │
└──────────┬───────────┘
           │
           ▼
      AppConfig
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
    app  postgres security
     │     │       │
     ▼     ▼       ▼
  server  pool   middleware
```

---

### 33. Final AppConfig Shape

The application now consumes:
```
env.app
```
```
env.postgres
```
```
env.security
```
Example:
```
env.app.port
```
```
env.app.nodeEnv
```
```
env.postgres.host
```
```
env.postgres.port
```
```
env.postgres.database
```
```
env.security.requestBodyLimit
```
This is much clearer than having unrelated configuration values at the root.

---

### 34. Important Design Decision

We deliberately keep the password inside:
```
env.postgres.password
```
because the database client needs it.

But the password should never be:
```
returned by an API
logged
included in an error
printed during startup
committed to Git
```
The configuration layer protects the boundary.

---

### 35. Future Configuration Improvements

We are intentionally not implementing all of these yet.

Later we can add:
```
LOG_LEVEL
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
BULLMQ_PREFIX
CORS_ORIGIN
JWT configuration
WebSocket configuration
database pool configuration
request timeout
shutdown timeout
rate-limit configuration
```
Eventually:
```
env.redis.host
env.redis.port
env.queue.*
env.logging.*
env.websocket.*
env.security.*
```
This will become especially important when we introduce Redis and BullMQ.

---

### 36. Configuration + Docker

When we later Dockerize the API:
```
Docker Container
       │
       ▼
Environment variables
       │
       ▼
src/config/env.ts
       │
       ▼
typed configuration
```
The Node application does not need to know that it is running inside Docker.

For example:
```
POSTGRES_HOST=postgres
```
inside Docker.

While locally:
```
POSTGRES_HOST=localhost
```
The application code remains unchanged.

---

### 37. Configuration + CI/CD

Later CI/CD might provide:
```
NODE_ENV=production
PORT=3000
POSTGRES_HOST=production-db
POSTGRES_PORT=5432
...
```
Our application simply validates them.

That gives us:
```
CI/CD
  │
  ▼
Environment
  │
  ▼
Configuration validation
  │
  ├── invalid → deployment fails
  │
  └── valid → application starts
```
This is the desired behavior.

---

### 38. Final Folder Structure
```
production-intelligence-platform/
│
├── src/
│   │
│   ├── config/
│   │   ├── config.types.ts
│   │   ├── env.ts
│   │   └── rate-limit.ts
│   │
│   ├── controllers/
│   │   ├── health.controller.ts
│   │   └── incident.controller.ts
│   │
│   ├── database/
│   │   ├── migrations/
│   │   ├── health.ts
│   │   ├── migrate.ts
│   │   ├── pool.ts
│   │   └── transaction.ts
│   │
│   ├── domain/
│   │   ├── incident.ts
│   │   ├── incident-query.ts
│   │   └── pagination.ts
│   │
│   ├── errors/
│   │   ├── AppError.ts
│   │   ├── NotFoundError.ts
│   │   └── ValidationError.ts
│   │
│   ├── logging/
│   │   ├── log-level.ts
│   │   ├── logger.ts
│   │   └── request-context.ts
│   │
│   ├── middleware/
│   │   ├── error.middleware.ts
│   │   ├── not-found.middleware.ts
│   │   ├── request-id.middleware.ts
│   │   ├── request-logging.middleware.ts
│   │   ├── security.middleware.ts
│   │   └── validation.middleware.ts
│   │
│   ├── repositories/
│   │   ├── incident-event.repository.interface.ts
│   │   ├── incident-event.repository.ts
│   │   ├── incident.repository.interface.ts
│   │   └── incident.repository.ts
│   │
│   ├── routes/
│   │   ├── health.routes.ts
│   │   └── incident.routes.ts
│   │
│   ├── server/
│   │   ├── lifecycle.ts
│   │   └── shutdown.ts
│   │
│   ├── services/
│   │   └── incident.service.ts
│   │
│   ├── types/
│   │   └── api-response.ts
│   │
│   ├── utils/
│   │   └── api-response.ts
│   │
│   ├── validators/
│   │   ├── incident-query.validator.ts
│   │   └── incident.validator.ts
│   │
│   ├── app.ts
│   ├── container.ts
│   └── server.ts
│
├── tests/
│   ├── config/
│   │   └── env.test.ts
│   │
│   ├── controllers/
│   ├── health/
│   ├── logging/
│   ├── middleware/
│   ├── security/
│   ├── server/
│   └── ...
│
├── .env
├── .env.example
├── .env.test
├── .gitignore
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

---