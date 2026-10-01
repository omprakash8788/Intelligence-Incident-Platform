### Production Intelligence & Incident Platform
### Module 1 — Lecture 23: Dockerizing the Node.js API

**Goal**: Containerize our existing TypeScript + Express API using a production-grade Docker image, while preserving configuration validation, graceful shutdown, health checks, and testing.

**Method**: Build → Test → Break → Fix → Verify.

**Important**: We are containerizing **only the API** in this lecture. PostgreSQL remains the existing Docker service. We will connect the containers properly in the next lecture.

---

### 1. Lecture Objective

Until now, our application has been running directly on the machine:
```
Windows
  │
  ├── Node.js
  ├── npm
  ├── TypeScript
  └── Express
```
We now want:
```
Docker
  │
  └── Node.js API container
```
The application should behave exactly the same.

Our Docker container must:

- build TypeScript
- run compiled JavaScript
- use production dependencies
- receive configuration through environment variables
- run as a non-root user
- expose the API port
- support graceful shutdown
- expose health endpoints
- avoid copying unnecessary files
- fail when required configuration is missing

---

### 2. Current Architecture

Before Docker:
```
┌──────────────────────────────┐
│          Windows             │
│                              │
│  Node.js                     │
│    │                         │
│    ▼                         │
│  Express                    │
│    │                         │
│    ├── PostgreSQL            │
│    │                         │
│    └── HTTP API              │
│                              │
└──────────────────────────────┘
```
PostgreSQL already runs in Docker:
```
Docker
└── PostgreSQL container
```

---

### 3. Target Architecture

After this lecture:
```
┌────────────────────────────────────────────┐
│                 Docker                     │
│                                            │
│  ┌────────────────────┐                    │
│  │   API Container    │                    │
│  │                    │                    │
│  │ Node.js            │                    │
│  │ Express            │                    │
│  │ compiled JS        │                    │
│  └─────────┬──────────┘                    │
│            │                                │
│            │                                │
│  ┌─────────▼──────────┐                    │
│  │ PostgreSQL         │                    │
│  │ Container          │                    │
│  └────────────────────┘                    │
│                                            │
└────────────────────────────────────────────┘
```
The next lecture will improve this architecture by using Docker Compose networking instead of manually running containers.

---

### 4. Docker Concepts We Need

Before writing the Dockerfile, understand these terms.

#### Image

An image is a packaged filesystem and application environment.
```
Dockerfile
    │
    ▼
Docker Image
```

---

#### Container

A container is a running instance of an image.
```
Image
  │
  ▼
Container
```
One image can create many containers.

---

#### Dockerfile

A Dockerfile describes how to build the image.

Example:
```
FROM node:22
```
means:

*Start with the Node.js 22 image.*

---

### 5. Step 1 — Verify Docker

Open PowerShell.

Run:
```
docker --version
```
You should see something similar to:
```
Docker version ...
```
Then:
```
docker compose version
```
Expected:
```
Docker Compose version ...
```
Finally:
```
docker info
```

Docker must be running.

---

### 6. Step 2 — Understand the Node Build

Our project currently contains:
```
src/
```
with TypeScript files.

TypeScript should not be the production runtime.

We compile:
```
src/
  │
  ▼
tsc
  │
  ▼
dist/
```
For example:
```
src/server.ts
```
becomes approximately:
```
dist/server.js
```
The production container should execute:
```
node dist/server.js
```
not:
```
tsx src/server.ts
```
This distinction is extremely important.

---

### 7. Step 3 — Create the Dockerfile
#### File: Dockerfile

Create this file in the project root:
```
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:22-bookworm-slim AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && \
    npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

---

### 8. Understanding the Dockerfile

Let's understand every instruction.

---

#### FROM
```
FROM node:22-bookworm-slim AS builder
```
This gives us:
```
Node.js
npm
Linux environment
```
The *builder* stage is used to compile TypeScript.

---

*WORKDIR*
```
WORKDIR /app
```
Inside the container:
```
/app
```
becomes the working directory.


---
```
Copy package files first
COPY package*.json ./
```
This copies:
```
package.json
package-lock.json
```
before copying source code.

Why?

Docker caches image layers.

If source code changes but dependencies do not:
```
package.json
package-lock.json
```
remain unchanged.

Docker can reuse the dependency installation layer.

---

### 9. npm ci vs npm install

We use:
```
RUN npm ci
```
instead of:
```
RUN npm install
```
For CI/container builds, *npm ci* is preferred because it uses the lockfile deterministically.

The relationship is:
```
package.json
      +
package-lock.json
      │
      ▼
    npm ci
      │
      ▼
same dependency tree
```
---

### 10. Copy Source
```
COPY tsconfig.json ./
COPY src ./src
```
Now Docker has:
```
/app
├── package.json
├── package-lock.json
├── tsconfig.json
└── src/
```

---

### 11. Compile TypeScript
```
RUN npm run build
```
This executes:
```
tsc
```
and creates:
```
/app/dist
```

---

### 12. Why Two Stages?

We have:
```
builder
```
and:
```
production
```
Builder:
```
Node
npm
TypeScript
Vitest
development dependencies
source code
```
Production:
```
Node
production dependencies
compiled JavaScript
```
We don't need:
```
TypeScript
Vitest
source TypeScript
```
inside the final runtime image.

---

### 13. Production Stage
```
FROM node:22-bookworm-slim AS production
```
This starts a clean image.

It does **not** inherit everything from the builder.

---

### 14. Production Dependencies
```
RUN npm ci --omit=dev
```
This installs only production dependencies.

Our production container does not need:
```
typescript
tsx
vitest
@types/*
```

---

### 15. Copy Compiled Application
```
COPY --from=builder /app/dist ./dist
```
This copies:
```
builder:/app/dist
```
into:
```
production:/app/dist
```
Only the compiled application is transferred.

---

### 16. Non-Root User

We use:
```
USER node
```
This is important.

Without it, the application may run as:
```
root
```
inside the container.

We want:
```
node
```
instead.

If an application is compromised, reducing unnecessary privileges reduces potential impact.

---

### 17. Expose Port
```
EXPOSE 3000
```
This documents the port the container expects the application to use.

Important:

*EXPOSE does not publish the port to your host.*

Publishing happens with:
```
-p 3000:3000
```

---

### 18. Start Command
```
CMD ["node", "dist/server.js"]
```
This is the production process.

The container runs:
```
node dist/server.js
```

---

### 19. Step 4 — Create .dockerignore

We don't want to send unnecessary files into the Docker build context.

#### File: .dockerignore

Create this file in the project root:
```
node_modules
dist
coverage
.git
.gitignore
.env
.env.test
*.log
README.md
```
This is extremely important.

We especially do not want:
```
.env
```
inside the Docker build context.

---

### 20. Why .dockerignore Matters

Without *.dockerignore*:
```
docker build
     │
     ▼
entire project
     │
     ├── node_modules
     ├── .git
     ├── .env
     ├── coverage
     └── source
```
With *.dockerignore*:
```
docker build
     │
     ▼
only required build files
```
This improves:

- build speed
- security
- image build efficiency
- reproducibility

---

### 21. Step 5 — Build the Docker Image

From the project root:
```
docker build -t production-intelligence-api:lecture23 .
```
Expected:
```
[builder ...]
...
[npm ci ...]
...
[npm run build ...]
...
[production ...]
...
Successfully tagged production-intelligence-api:lecture23
```

---

### 22. Verify the Image

Run:
```
docker images
```
You should see:
```
production-intelligence-api
```
with tag:
```
lecture23
```

---

### 23. Inspect Image Metadata

Run:
```
docker image inspect production-intelligence-api:lecture23
```
This will show metadata about the image.

Don't worry about understanding every field yet.

Focus on:
```
Architecture
OS
Entrypoint
Cmd
WorkingDir
Env
```

---

### 24. Step 6 — Run the API Container

We first need PostgreSQL running.

Run:
```
docker compose up -d postgres
```
Check:
```
docker compose ps
```
Now run the API container.
```
docker run --rm `
  --name production-intelligence-api `
  -p 3000:3000 `
  -e NODE_ENV=production `
  -e PORT=3000 `
  -e POSTGRES_HOST=host.docker.internal `
  -e POSTGRES_PORT=5432 `
  -e POSTGRES_DATABASE=production_intelligence `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  production-intelligence-api:lecture23
```

---

### 25. Important: Why host.docker.internal?

Right now PostgreSQL is running in Docker.

But we have not yet created a shared Docker network for the API and PostgreSQL.

Therefore the API container cannot use:
```
localhost
```
for PostgreSQL.

Inside the API container:
```
localhost
```
means:
```
API container itself
```
not your Windows machine.

For this temporary setup:
```
host.docker.internal
```
allows the container to reach the host.

This is only a transitional setup.

The next lecture will use proper Docker Compose networking.

---

### 26. Verify Container Is Running

Open another PowerShell window.

Run:
```
docker ps
```
You should see:
```
production-intelligence-api
```
and:
```
production-intelligence-postgres
```

---

### 27. Step 7 — Test Liveness

Run:
```
Invoke-WebRequest http://localhost:3000/health/live
```
Expected:
```
StatusCode : 200
```
Our application is alive.

---

### 28. Step 8 — Test Readiness

Run:
```
Invoke-WebRequest http://localhost:3000/health/ready
```
Expected:
```
StatusCode : 200
```
This proves:
```
API container
      │
      ▼
PostgreSQL
```
communication works.

---

### 29. Test Response Body

Run:
```
Invoke-RestMethod http://localhost:3000/health/live
```
You should receive the application's health response.

The exact response shape depends on the existing health controller implementation.

---

### 30. Step 9 — Test Incident API

The application currently exposes:
```
POST /incidents
GET  /incidents
GET  /incidents/:id
```
First:
```
Invoke-RestMethod `
  -Uri http://localhost:3000/incidents `
  -Method GET
```
Expected:
```
success = true
```
with the incident list.

---

### 31. Create an Incident

Run:
```
$body = @{
  service = "payment-service"
  severity = "high"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://localhost:3000/incidents `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```
Expected:
```
success = true
```
The API container has now:
```
HTTP
 ↓
Express
 ↓
Controller
 ↓
Service
 ↓
Repository
 ↓
PostgreSQL
```

---

### 32. Step 10 — Verify Request ID

Our application already has request ID middleware.

Run:
```
$response = Invoke-WebRequest `
  http://localhost:3000/health/live
```
Inspect:
```
$response.Headers
```
Look for:
```
X-Request-ID
```
This proves that our earlier architecture still works inside Docker.

---

### 33. Step 11 — Verify Rate Limiting

Our earlier rate limiter is still active.

Run:
```
Invoke-WebRequest `
  http://localhost:3000/incidents
```
The response should include the rate-limit headers.

For example:
```
RateLimit
```
The exact header formatting depends on the installed *express-rate-limit* version.

---

### 34. Step 12 — Verify Security Headers

Run:
```
$response = Invoke-WebRequest `
  http://localhost:3000/health/live
```
Then:
```
$response.Headers
```
Look for headers generated by Helmet.

This verifies that:
```
Docker
  ↓
Node
  ↓
Express
  ↓
Helmet
```
is functioning normally.

---

### 35. Step 13 — Intentional Break #1: Invalid Database Host

Now we intentionally break the container.

Stop the running API container with:
```
docker stop production-intelligence-api
```
Run it again with an invalid host:
```
docker run --rm `
  --name production-intelligence-api `
  -p 3000:3000 `
  -e NODE_ENV=production `
  -e PORT=3000 `
  -e POSTGRES_HOST=invalid-database-host `
  -e POSTGRES_PORT=5432 `
  -e POSTGRES_DATABASE=production_intelligence `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  production-intelligence-api:lecture23
```
The application itself may still start because configuration syntax is valid.

Now call:
```
Invoke-WebRequest http://localhost:3000/health/ready
```
Expected:
```
503
```
Why?

Because:
```
API
 │
 └── PostgreSQL connection
          │
          X
```
Readiness correctly reports the application as not ready.

This is an important distinction:

*A syntactically valid configuration is not necessarily a healthy runtime dependency.*

---

### 36. Fix Intentional Break #1

Stop the container:
```
docker stop production-intelligence-api
```
Start it again with:
```
POSTGRES_HOST=host.docker.internal
```
Then:
```
Invoke-WebRequest http://localhost:3000/health/ready
```
Expected:
```
200
```

---

### 37. Intentional Break #2 — Missing Required Secret

Stop the API:
```
docker stop production-intelligence-api
```
Now omit:
```
POSTGRES_PASSWORD
```
Run:
```
docker run --rm `
  --name production-intelligence-api `
  -p 3000:3000 `
  -e NODE_ENV=production `
  -e PORT=3000 `
  -e POSTGRES_HOST=host.docker.internal `
  -e POSTGRES_PORT=5432 `
  -e POSTGRES_DATABASE=production_intelligence `
  -e POSTGRES_USER=postgres `
  production-intelligence-api:lecture23
```
Expected startup failure:
```
POSTGRES_PASSWORD environment variable is required
```
The container exits.

This proves our Lecture 22 configuration hardening is working inside Docker.

---

### 38. Fix Intentional Break #2

Start the container with:
```
docker run --rm `
  --name production-intelligence-api `
  -p 3000:3000 `
  -e NODE_ENV=production `
  -e PORT=3000 `
  -e POSTGRES_HOST=host.docker.internal `
  -e POSTGRES_PORT=5432 `
  -e POSTGRES_DATABASE=production_intelligence `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  production-intelligence-api:lecture23
```
Expected:
```
Server started
```

---

### 39. Step 14 — Verify Non-Root Execution

Our Dockerfile contains:
```
USER node
```
Verify it.

Run:
```
docker run --rm `
  production-intelligence-api:lecture23 `
  id
```
Expected output should indicate the *node* user rather than root.

You should **not** see:
```
uid=0(root)
```

---

### 40. Why Non-Root Matters

Imagine the application process is compromised.

If it runs as:
```
root
```
the process has extremely broad permissions inside the container.

If it runs as:
```
node
```
permissions are reduced.

This is not a complete security solution, but it follows the principle:

**Run with the minimum privileges required.**

---

### 41. Step 15 — Container Health Check

Now we want Docker itself to understand application health.

Our application already has:
```
GET /health/live
```
We can use it.

However, the production image currently does not include *curl* or *wget*.

Rather than adding another package only for the health check, we can use Node itself.

We will modify the Dockerfile.

---

### 42. Add Docker Health Check
#### File: Dockerfile

Replace the complete file with:
```
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:22-bookworm-slim AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && \
    npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
```

---

### 43. Understand the Health Check

Docker periodically executes:
```
GET /health/live
```
The flow becomes:
```
Docker
  │
  │ health check
  ▼
127.0.0.1:3000/health/live
  │
  ▼
Express
  │
  ▼
Liveness controller
```
If the endpoint succeeds:
```
healthy
```
If it fails repeatedly:
```
unhealthy
```

---

### 44. Why Liveness Instead of Readiness?

We use:
```
/health/live
```
for the container health check.

Why?

Liveness answers:

*Is the application process alive?*

Readiness answers:

*Is the application currently able to serve traffic including its dependencies?*

These are different questions.

If PostgreSQL temporarily goes down, we don't necessarily want the container runtime to conclude:
```
Node process is dead
```
The process is still alive.

Our orchestration layer can separately use readiness.

---

### 45. Rebuild the Image

Because we changed the Dockerfile:
```
docker build `
  -t production-intelligence-api:lecture23 .
```

---

### 46. Run the New Container
```
docker run -d `
  --name production-intelligence-api `
  -p 3000:3000 `
  -e NODE_ENV=production `
  -e PORT=3000 `
  -e POSTGRES_HOST=host.docker.internal `
  -e POSTGRES_PORT=5432 `
  -e POSTGRES_DATABASE=production_intelligence `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  production-intelligence-api:lecture23
```

---

### 47. Inspect Container Health

Run:
```
docker ps
```
Initially you may see:
```
health: starting
```
After the health check executes:
```
healthy
```
You can inspect it with:
```
docker inspect `
  --format="{{json .State.Health}}" `
  production-intelligence-api
```

---

### 48. Step 16 — Graceful Shutdown

We already implemented graceful shutdown in Lecture 18.

Now Docker gives us a chance to verify it.

Our application listens for:
```
SIGTERM
SIGINT
```
Docker normally sends:
```
SIGTERM
```
when a container is stopped.

Run:
```
docker stop production-intelligence-api
```
The application should execute:
```
SIGTERM
   ↓
shutdown()
   ↓
mark shutting_down
   ↓
close HTTP server
   ↓
close PostgreSQL pool
   ↓
mark stopped
```

---

### 49. Why This Matters

Without graceful shutdown:
```
Container
   ↓
SIGTERM
   ↓
process immediately killed
```
Potential consequences:

- requests interrupted
- database connections abruptly closed
- partially completed operations
- incomplete cleanup

Our architecture is now prepared for controlled shutdown.

This becomes even more important once we introduce:
```
Redis
BullMQ
workers
WebSockets
background jobs
```

---

### 50. Step 17 — Production Dependency Installation

Our production image uses:
```
RUN npm ci --omit=dev
```
This means the final image should not contain development dependencies.

Examples of development-only packages:
```
typescript
tsx
vitest
@types/node
@types/express
```
The runtime only needs:
```
express
dotenv
pg
helmet
express-rate-limit
```
plus any other actual runtime dependencies in *package.json*.

---

### 51. Verify Production Dependencies

Run a shell inside the image as the default user:
```
docker run --rm `
  production-intelligence-api:lecture23 `
  npm list --depth=0
```
The result should contain runtime dependencies.

Development tooling should not be installed by the production stage.

---

### 52. Why We Don't Copy node_modules

Never do this:
```
COPY node_modules ./node_modules
```
Why?

Because *node_modules* belongs to the host environment.

The host could be:
```
Windows
```
while the container is:
```
Linux
```
Native dependencies can differ.

Instead:
```
package-lock.json
       ↓
npm ci
       ↓
Linux dependencies
```
The container builds its own dependency tree.

---

### 53. Step 18 — Verify the Build

Run:
```
npm run build
```
Then:
```
docker build `
  -t production-intelligence-api:lecture23 .
```
Both must succeed.

---

### 54. Step 19 — Run the Full Test Suite

The application tests should still run on the host:
```
npm run test:run
```
Expected:
```
Test Files  ... passed
Tests       ... passed
```
Dockerizing the application must not break our existing test suite.

---

### 55. Test Strategy

We now have three levels of verification.

#### Level 1 — TypeScript
```
npm run build
```
Checks:
```
Type correctness
Compilation
Imports
```

---

#### Level 2 — Automated tests
```
npm run test:run
```
Checks:
```
Controllers
Middleware
Security
Rate limiting
Request IDs
Health
Shutdown
Configuration
```

---

#### Level 3 — Container integration
```
docker build
       ↓
docker run
       ↓
health
       ↓
database
       ↓
API
```
This is important because an application can pass unit tests and still fail inside its production container.

---

### 56. Final Dockerfile
#### File: Dockerfile

The final Lecture 23 version is:
```
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:22-bookworm-slim AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && \
    npm cache clean --force

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
```

---

### 57. Final .dockerignore
#### File: .dockerignore
```
node_modules
dist
coverage
.git
.gitignore
.env
.env.test
*.log
README.md
```
---

### 58. Important Security Observation

We are **not** putting this into the Dockerfile:
```
ENV POSTGRES_PASSWORD=postgres
```
That would bake the password into the image.

Bad:
```
ENV POSTGRES_PASSWORD=secret
```
Good:
```
Docker image
     │
     └── contains application
     
Container runtime
     │
     └── receives secret
```
For example:
```
-e POSTGRES_PASSWORD=postgres
```
Later, production deployments should use a proper secret-management mechanism instead of putting secrets directly into shell history.

---

### 59. Image vs Container Configuration

This distinction is critical.

#### Image

Contains:
```
Node
application
dependencies
compiled JS
health check
```
#### Container

Receives:
```
NODE_ENV
PORT
POSTGRES_HOST
POSTGRES_PORT
POSTGRES_DATABASE
POSTGRES_USER
POSTGRES_PASSWORD
```
Therefore:
```
ONE IMAGE
   │
   ├── development-like environment
   ├── test environment
   └── production environment
```
The image does not need to be rebuilt just because the database host changes.

---

### 60. Final Architecture

After Lecture 23:
```
                         HOST
                          │
                          │
              ┌───────────▼───────────┐
              │        Docker         │
              │                       │
              │  ┌─────────────────┐  │
HTTP :3000 ──►│  │   API Container  │  │
              │  │                 │  │
              │  │ Node.js        │  │
              │  │ Express        │  │
              │  │ TypeScript JS  │  │
              │  │ Helmet         │  │
              │  │ Rate Limiter   │  │
              │  └────────┬────────┘  │
              │           │           │
              │           │           │
              │  ┌────────▼────────┐  │
              │  │ PostgreSQL      │  │
              │  │ Container       │  │
              │  └─────────────────┘  │
              │                       │
              └───────────────────────┘
```

---

### 61. Complete Request Flow

A request now travels through:
```
Client
  │
  ▼
Docker published port 3000
  │
  ▼
Node.js container
  │
  ▼
Express
  │
  ├── Helmet
  │
  ├── JSON body parser
  │
  ├── Request ID
  │
  ├── Request logging
  │
  ├── Rate limiting
  │
  ├── Routing
  │
  ├── Validation
  │
  ├── Controller
  │
  ├── Service
  │
  └── Repository
          │
          ▼
      PostgreSQL
```
This is becoming a real production-style backend architecture.


---

### 62. Final Folder Structure
````
production-intelligence-platform/
│
├── src/
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
│   ├── controllers/
│   ├── health/
│   ├── logging/
│   ├── middleware/
│   ├── security/
│   ├── server/
│   └── ...
│
├── .dockerignore
├── .env
├── .env.example
├── .env.test
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package-lock.json
├── package.json
└── tsconfig.json
```
---
