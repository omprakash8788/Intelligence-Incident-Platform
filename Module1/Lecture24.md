### Production Intelligence & Incident Platform
### Module 1 — Lecture 24: Docker Compose — API + PostgreSQL

**Goal**: Move from manually connected containers to a proper Docker Compose architecture where the API and PostgreSQL communicate through a private Docker network using service discovery.

**Method**: Build → Test → Break → Fix → Verify.

**Important**: We are still **not adding Redis or BullMQ**. First, the API + PostgreSQL foundation must be reliable.

---

### 1. Lecture Objective

At the end of this lecture, we want:
```
                    Docker Compose
                         │
          ┌──────────────┴──────────────┐
          │                             │
          ▼                             ▼
   ┌──────────────┐              ┌──────────────┐
   │     API      │              │  PostgreSQL  │
   │              │              │              │
   │ Node.js      │─────────────►│ PostgreSQL   │
   │ Express      │   network    │              │
   └──────────────┘              └──────────────┘
```
The API will connect to PostgreSQL using:
```
POSTGRES_HOST=postgres
```
Not:
```
POSTGRES_HOST=localhost
```
and not:
```
POSTGRES_HOST=host.docker.internal
```
This is the important architectural change.


---

### 2. Where We Are

After Lecture 23:
```
Docker
│
├── API container
│
└── PostgreSQL container
```
But the API was temporarily connecting through:
```
host.docker.internal
```
That was useful for learning, but it is not our final architecture.

---

### 3. The Problem With the Current Setup

Suppose we run:
```
API container
    │
    ▼
host.docker.internal
    │
    ▼
PostgreSQL
```
This introduces unnecessary dependency on the host.

We want:
```
API container
    │
    ▼
Docker network
    │
    ▼
PostgreSQL container
```
Docker Compose gives us this automatically.

---

### 4. Target Architecture

Our final local architecture:
```
┌─────────────────────────────────────────────────────┐
│                    Docker                           │
│                                                     │
│  ┌───────────────────┐      ┌───────────────────┐  │
│  │       api         │      │     postgres      │  │
│  │                   │      │                   │  │
│  │ Node.js           │      │ PostgreSQL 17     │  │
│  │ Express           │─────►│                   │  │
│  │ Port 3000         │      │ Port 5432         │  │
│  └─────────┬─────────┘      └─────────┬─────────┘  │
│            │                          │            │
│            └───────────┬──────────────┘            │
│                        │                           │
│                  app-network                       │
│                                                     │
└─────────────────────────────────────────────────────┘
                         │
                         │
                  Host port 3000
                         │
                         ▼
                      Client
```

---

### 5. Docker Compose Concepts
#### Service

A Compose service describes a container.

Example:
```
services:
  api:
```
and:
```
services:
  postgres:
```

---

#### Service Name = DNS Name

This is one of the most important concepts in this lecture.

If Compose has:
```
services:
  postgres:
```
then other containers on the same network can reach it using:
```
postgres
```
Therefore:
```
POSTGRES_HOST=postgres
```
works.

Docker provides internal DNS.

---

### 6. Step 1 — Stop the Existing API Container

If Lecture 23's manually started container is still running:
```
docker stop production-intelligence-api
```
Then:
```
docker rm production-intelligence-api
```
Verify:
```
docker ps
```
Only PostgreSQL may remain.

---

### 7. Step 2 — Prepare Docker Compose

We are going to replace the current Compose file.

#### File: docker-compose.yml

**Replace the complete file with the following:**
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

    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U postgres -d production_intelligence"
        ]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

    networks:
      - app-network


  api:
    build:
      context: .
      dockerfile: Dockerfile

    container_name: production-intelligence-api

    restart: unless-stopped

    environment:
      NODE_ENV: production
      PORT: 3000

      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DATABASE: production_intelligence
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres

    ports:
      - "3000:3000"

    depends_on:
      postgres:
        condition: service_healthy

    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/health/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

    networks:
      - app-network


networks:
  app-network:
    driver: bridge


volumes:
  postgres_data:
```

---

### 8. Step 3 — Create the API Service

The API service:
```
api:
```
uses:
```
build:
  context: .
  dockerfile: Dockerfile
```
That means Compose will build our existing production Dockerfile.

Architecture:
```
docker-compose.yml
       │
       ▼
Dockerfile
       │
       ▼
production-intelligence-api image
       │
       ▼
API container
```

---

### 9. API Environment

The API receives:
```
environment:
  NODE_ENV: production
  PORT: 3000

  POSTGRES_HOST: postgres
  POSTGRES_PORT: 5432
  POSTGRES_DATABASE: production_intelligence
  POSTGRES_USER: postgres
  POSTGRES_PASSWORD: postgres
```
The critical line is:
```
POSTGRES_HOST: postgres
```
Why?

Because:
```
postgres
```
is the Compose service name.

---

### 10. Why localhost Would Be Wrong

Inside the API container:
```
localhost
```
means:
```
API container
```
not:
```
PostgreSQL container
```
So:
```
POSTGRES_HOST=localhost
```
would mean:
```
API → itself:5432
```
and fail.

Instead:
```
POSTGRES_HOST=postgres
```
means:
```
API → Docker DNS → postgres container
```

---

### 11. Step 4 — PostgreSQL Configuration

Our PostgreSQL service remains:
```
postgres:
  image: postgres:17
```
with:
```
POSTGRES_DB: production_intelligence
POSTGRES_USER: postgres
POSTGRES_PASSWORD: postgres
```
These values must match the API configuration.

The relationship is:
```
PostgreSQL
│
├── database = production_intelligence
├── user     = postgres
└── password = postgres
        │
        ▼
API
│
├── database = production_intelligence
├── user     = postgres
└── password = postgres
```
For this local learning environment, these are development credentials.

Do not use them in a real production deployment.

---


### 12. Step 5 — Configure the Docker Network

We explicitly create:
```
networks:
  app-network:
    driver: bridge
```
Then attach both services:
```
networks:
  - app-network
```
The network becomes:
```
app-network
      │
      ├── api
      │
      └── postgres
```
The API can resolve:
```
postgres
```
through Docker's internal DNS.

---

### 13. Step 6 — Configure Persistent PostgreSQL Storage

We use:
```
volumes:
  - postgres_data:/var/lib/postgresql/data
```
This means PostgreSQL data lives in:
```
postgres_data
```
rather than only inside the container filesystem.

Therefore:
```
Container deleted
       │
       ▼
Volume remains
       │
       ▼
Database data remains
```
This is essential.

---

### 14. Container vs Volume

Remember:
```
Container
```
is disposable.
```
Volume
```
is persistent storage.

Therefore:
```
postgres container
       │
       ▼
postgres_data volume
```
Deleting the container does not automatically delete the volume.

---

### 15. Step 7 — PostgreSQL Health Check

We add:
```
healthcheck:
  test:
    [
      "CMD-SHELL",
      "pg_isready -U postgres -d production_intelligence"
    ]
```
This asks PostgreSQL:

*Are you ready to accept connections?*

Docker then reports:
```
starting
```
or:
```
healthy
```
or:
```
unhealthy
```

---

### 16. Why Health Check Matters

Without a health check:
```
docker compose up
       │
       ├── PostgreSQL starts
       │
       └── API starts immediately
```
But PostgreSQL might not yet be ready.

The API may attempt:
```
connect PostgreSQL
      │
      X
connection refused
```
With a health check:
```
PostgreSQL starts
      │
      ▼
health check
      │
      ▼
healthy
      │
      ▼
API starts
```
This is much more deterministic.

---

### 17. Step 8 — API Health Check

Our API already exposes:
```
GET /health/live
```
Compose can check it.

The API health check is:
```
healthcheck:
  test:
    [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:3000/health/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
    ]
```
This uses Node itself.

We don't need to install *curl*.

---

### 18. Step 9 — Startup Dependency

We use:
```
depends_on:
  postgres:
    condition: service_healthy
```
This means Compose waits until PostgreSQL reports healthy before starting the API.

Important:

*depends_on* controls startup ordering.

It does **not** magically solve all runtime failures.

For example:
```
PostgreSQL healthy
       ↓
API starts
       ↓
PostgreSQL later crashes
```
Compose does not make the database permanently reliable.

The application still needs:
```
retries
readiness checks
connection pooling
error handling
```
We already have several of these pieces.

---

### 19. Step 10 — Validate the Compose File

Before starting anything, run:
```
docker compose config
```
This is extremely useful.

It validates and renders the Compose configuration.

You should not see YAML errors.

---

### 20. Step 11 — Build the Stack

Run:
```
docker compose build
```
Compose will:
```
Build API image
     │
     ▼
Dockerfile
     │
     ├── builder stage
     │
     └── production stage
```
PostgreSQL does not need to be built because it uses:
```
image: postgres:17
```

---

### 21. Step 12 — Start the Stack

Run:
```
docker compose up -d
```
Expected:
```
[+] Running ...
```
Then:
```
docker compose ps
```

---

### 22. Step 13 — Verify Containers

Run:
```
docker compose ps
```
You should see two services:
```
postgres
api
```
Ideally:
```
postgres   healthy
api        healthy
```
The API may briefly show:
```
health: starting
```
Wait several seconds and run:
```
docker compose ps
```
again.

---

### 23. View All Logs

Run:
```
docker compose logs
```
Or specifically API:
```
docker compose logs api
```
PostgreSQL:
```
docker compose logs postgres
```
Follow API logs:
```
docker compose logs -f api
```
Press:
```
Ctrl+C
```
to stop following logs.

---

### 24. Step 14 — Verify Docker Networking

Run:
```
docker network ls
```
You should see a Compose-created network similar to:
```
production-intelligence-platform_app-network
```
The exact generated prefix depends on the Compose project name.

Inspect it:
```
docker network inspect production-intelligence-platform_app-network
```
You should see both:
```
production-intelligence-api
production-intelligence-postgres
```
attached to the network.

---

### 25. Verify Container DNS

The API should resolve:
```
postgres
```
We can test this from the API container.

Run:
```
docker compose exec api node -e "require('node:dns').lookup('postgres', (err, address) => { if (err) { console.error(err); process.exit(1); } console.log(address); })"
```
Expected:
```
172.x.x.x
```
or another Docker-network IP.

The exact IP is not important.

The important part is:
```
postgres
   ↓
resolves to PostgreSQL container IP
```

---

### 26. Why This Is Important

We now have:
```
API
 │
 │ DNS lookup
 ▼
postgres
 │
 ▼
PostgreSQL container IP
```
No hardcoded IP address.

This is service discovery.

If PostgreSQL's container IP changes:
```
API code
```
doesn't change.

Docker DNS resolves the current address.

---

### 27. Step 15 — Verify PostgreSQL

Run:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT current_database();"
```
Expected:
```
 production_intelligence
```
Then:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT version();"
```
You should see PostgreSQL 17.

---

### 28. Verify Tables

Run:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "\dt"
```
You should see your database tables, including:
```
incidents
incident_events
schema_migrations
```
assuming migrations have already been applied.

---

### 29. Step 16 — Verify API Liveness

Run:
```
Invoke-WebRequest `
  http://localhost:3000/health/live
```
Expected:
```
StatusCode : 200
```

---

### 30. Step 17 — Verify API Readiness

Run:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
StatusCode : 200
```
This proves:
```
API
 │
 ▼
PostgreSQL
 │
 ▼
SELECT 1
 │
 ▼
success
```

---

### 31. Step 18 — Verify Incident API

Run:
```
Invoke-RestMethod `
  http://localhost:3000/incidents
```
Expected:
```
success = true
```
Now create an incident.
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

---

### 32. Verify the Database Record

Run:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT id, service, severity, status FROM incidents ORDER BY created_at DESC LIMIT 5;"
```
You should see the newly created:
```
payment-service
high
```
incident.

This verifies the complete path:
```
HTTP
 ↓
API container
 ↓
Express
 ↓
Service
 ↓
Repository
 ↓
PostgreSQL container
 ↓
Persistent volume
```

---

### 33. Step 19 — Verify Database Persistence

This is one of the most important tests.

First create an incident.
```
$body = @{
  service = "order-service"
  severity = "critical"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://localhost:3000/incidents `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
```
Verify it:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT service, severity FROM incidents ORDER BY created_at DESC LIMIT 5;"
```
Now stop the stack:
```
docker compose down
```
Important:

We did **not** use:
```
docker compose down -v
```
because *-v* removes the volumes.

---

### 34. Start the Stack Again

Run:
```
docker compose up -d
```
Wait until healthy:
```
docker compose ps
```
Now query the database again:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT service, severity FROM incidents ORDER BY created_at DESC LIMIT 5;"
```
The previous incident should still exist.

This proves:
```
Container deleted
       ↓
Volume remains
       ↓
Data remains
```

---

### 35. Critical Difference: down vs down -v
#### This:
```
docker compose down
```
removes:
```
containers
network
```
but preserves named volumes.

---

#### This:
```
docker compose down -v
```
removes:
```
containers
network
volumes
```
Therefore:

**Never casually run docker compose down -v when you care about your local database data.**

For our learning environment, use it only when intentionally resetting the database.

---

### 36. Step 20 — Intentional Break #1

Now we deliberately break service discovery.

#### File: docker-compose.yml

Temporarily change:
```
POSTGRES_HOST: postgres
```
to:
```
POSTGRES_HOST: wrong-postgres
```
Then run:
```
docker compose up -d --force-recreate
```
Check:
```
docker compose ps
```
The API may start because the configuration itself is syntactically valid.

Now:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
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
 ▼
wrong-postgres
 │
 X
DNS / connection failure
```
Our readiness endpoint detects the dependency failure.

---

### 37. Fix Intentional Break #1

Restore:

#### File: docker-compose.yml
```
POSTGRES_HOST: postgres
```
Then:
```
docker compose up -d --force-recreate
```
Check:
```
docker compose ps
```
Then:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
200
```

---

### 38. Step 21 — Intentional Break #2

Now break the database credentials.

#### File: docker-compose.yml

Temporarily change:
```
POSTGRES_PASSWORD: postgres
```
inside the API service to:
```
POSTGRES_PASSWORD: wrong-password
```
Important:

There are two password locations.

PostgreSQL:
```
postgres:
  environment:
    POSTGRES_PASSWORD: postgres
```
API:
```
api:
  environment:
    POSTGRES_PASSWORD: wrong-password
```
Only break the API password.

Recreate:
```
docker compose up -d --force-recreate
```
Now:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
503
```
because:
```
API
 │
 │ wrong password
 ▼
PostgreSQL
 │
 X
authentication failed
```

---

### 39. Fix Intentional Break #2

Restore:
```
POSTGRES_PASSWORD: postgres
```
under the API service.

Then:
```
docker compose up -d --force-recreate
```
Check:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
200
```

---

### 40. Step 22 — Intentional Break #3

Now break the PostgreSQL service itself.

Run:
```
docker compose stop postgres
```
Check:
```
docker compose ps
```
The API container may still be running.

Now:
```
Invoke-WebRequest `
  http://localhost:3000/health/live
```
Expected:
```
200
```
This is important.

The Node process is alive.

Now:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
503
```
This demonstrates exactly why we have two endpoints:
```
/live
```
answers:

*Is the application alive?*
```
/ready
```
answers:

*Can the application currently serve requests requiring its dependencies?*

---

### 41. Fix Intentional Break #3

Start PostgreSQL:
```
docker compose start postgres
```
Wait:
```
docker compose ps
```
Once PostgreSQL is healthy:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
200
```
---

### 42. Step 23 — Database Restart Test

Run:
```
docker compose restart postgres
```
Watch:
```
docker compose ps
```
PostgreSQL will temporarily transition through:
```
starting
```
and eventually:
```
healthy
```
Now check:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
200
```
after PostgreSQL becomes ready.


---

### 43. Step 24 — API Restart Test

Run:
```
docker compose restart api
```
Check:
```
docker compose ps
```
The API should return to:
```
healthy
```
Then:
```
Invoke-WebRequest `
  http://localhost:3000/health/live
```
Expected:
```
200
```
And:
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
200
```

---

### 44. Step 25 — Migration Execution

Our application has a migration runner:
```
src/database/migrate.ts
```
and:
```
npm run migrate
```
However, our current production Docker image contains only:
```
dist/
```
and production dependencies.

The migration runner is compiled into:
```
dist/database/migrate.js
```
because the entire *src* directory is compiled.

Therefore we can execute:
```
node dist/database/migrate.js
```
inside the API image.

But there is an important issue:
The API container starts using:
```
CMD ["node", "dist/server.js"]
```
so migrations are not automatically executed.

This is intentional.

---

### 45. Why We Don't Automatically Run Migrations in CMD

A tempting Dockerfile would be:
```
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/server.js"]
```
We are **not** doing that.

Why?

Because:
```
application startup
```
and:
```
database schema migration
```
are different responsibilities.

Automatically running migrations from every API replica can create operational problems later.

For example:
```
API replica 1
API replica 2
API replica 3
```
could all attempt migrations simultaneously.

We will design a proper migration strategy later.

---

### 46. Run Migrations Manually

With the Compose stack running:
```
docker compose run --rm api `
  node dist/database/migrate.js
```
This creates a temporary API container and executes the migration runner.

Expected:
```
Migrations completed
```
or equivalent output from our migration runner.

---

### 47. Verify Migration State

Run:
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT * FROM schema_migrations ORDER BY version;"
```
You should see the migration versions that have already been applied.

---

### 48. Important Migration Principle

We now have:
```
API container
      │
      ├── serves HTTP
      │
      └── contains migration executable
```
But migration execution is a separate operational step.

Later, when we build more infrastructure, we can create a dedicated migration job:
```
Deployment
    │
    ▼
Migration Job
    │
    ▼
PostgreSQL
    │
    ▼
Success
    │
    ▼
API deployment
```
That is a more scalable production pattern.

---

### 49. Step 26 — Production Configuration

Our Compose file currently contains:
```
POSTGRES_PASSWORD: postgres
```
This is acceptable only for our local learning environment.

Do not use this pattern for a real production deployment.

A production system should obtain secrets through an appropriate secret-management mechanism.

The architecture should become:
```
Production Secret Store
        │
        ▼
Deployment environment
        │
        ▼
API container
```
not:
```
Git repository
    │
    ▼
docker-compose.yml
    │
    ▼
real password
```

---

### 50. Configuration Flow

Our current local environment:
```
docker-compose.yml
        │
        ▼
environment variables
        │
        ▼
process.env
        │
        ▼
src/config/env.ts
        │
        ▼
typed env object
```
This connects directly to Lecture 22.

---

### 51. Docker Compose Does Not Replace Configuration Validation

Even though Compose provides:
```
POSTGRES_HOST: postgres
```
our application still validates:
```
POSTGRES_HOST
POSTGRES_PORT
POSTGRES_DATABASE
POSTGRES_USER
POSTGRES_PASSWORD
```
This is good architecture.

Docker manages the environment.

The application validates the environment.

---

### 52. Step 27 — Useful Compose Commands

Start:
```
docker compose up -d
```
Start and rebuild:
```
docker compose up -d --build
```
Stop containers:
```
docker compose stop
```
Start stopped containers:
```
docker compose start
```
Stop and remove containers/network:
```
docker compose down
```
Stop and remove containers/network/volumes:
```
docker compose down -v
```
View status:
```
docker compose ps
```
View logs:
```
docker compose logs
```
Follow API logs:
```
docker compose logs -f api
```
Follow PostgreSQL logs:
```
docker compose logs -f postgres
```
Execute command inside API:
```
docker compose exec api <command>
```
Execute command inside PostgreSQL:
```
docker compose exec postgres <command>
```
Build:
```
docker compose build
```

---

### 53. Rebuild After Dockerfile Changes

If you modify:
```
Dockerfile
```
run:
```
docker compose up -d --build
```
If you modify:
```
src/
```
you also need to rebuild because the production image contains compiled JavaScript:
```
docker compose up -d --build
```

---

### 54. Why There Is No Hot Reload

Our production Dockerfile runs:
```
node dist/server.js
```
It does not run:
```
tsx watch
```
This is intentional.

Production:
```
source
 ↓
build
 ↓
image
 ↓
container
```
Development hot reload is a separate concern.

Later we can create a development Compose configuration with:
```
tsx watch
volume mounts
source code
```
but we should not mix development and production container behavior.

---

### 55. Step 28 — Full Build Verification

First:
```
npm run build
```
Expected:
```
success
```
Then:
```
npm run test:run
```
Expected:
```
all tests passing
```
Then:
```
docker compose config
```
Expected:
```
valid Compose configuration
```
Then:
```
docker compose build
```
Expected:
```
API image successfully built
```
Then:
```
docker compose up -d
```
Expected:
```
API healthy
PostgreSQL healthy
```

---

### 56. Full Integration Verification

Run these in order.

#### 1. Check containers
```
docker compose ps
```
#### 2. Check liveness
```
Invoke-WebRequest `
  http://localhost:3000/health/live
```
Expected:
```
200
```
#### 3. Check readiness
```
Invoke-WebRequest `
  http://localhost:3000/health/ready
```
Expected:
```
200
```
#### 4. Query incidents
```
Invoke-RestMethod `
  http://localhost:3000/incidents
  ```
#### 5. Create incident
```
$body = @{
  service = "payment-service"
  severity = "critical"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri http://localhost:3000/incidents `
  -Method POST `
  -ContentType "application/json" `
  -Body $body
  ```
#### 6. Verify PostgreSQL
```
docker compose exec postgres `
  psql -U postgres -d production_intelligence `
  -c "SELECT id, service, severity, status FROM incidents ORDER BY created_at DESC LIMIT 5;"
  ```

---

### 57. Final docker-compose.yml
#### File: docker-compose.yml

The final Lecture 24 version:
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

    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U postgres -d production_intelligence"
        ]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

    networks:
      - app-network


  api:
    build:
      context: .
      dockerfile: Dockerfile

    container_name: production-intelligence-api

    restart: unless-stopped

    environment:
      NODE_ENV: production
      PORT: 3000

      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DATABASE: production_intelligence
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres

    ports:
      - "3000:3000"

    depends_on:
      postgres:
        condition: service_healthy

    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/health/live').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

    networks:
      - app-network


networks:
  app-network:
    driver: bridge


volumes:
  postgres_data:
```

---

### 58. Final Architecture

```
                         HOST
                          │
                          │
                    localhost:3000
                          │
                          ▼
┌─────────────────────────────────────────────────┐
│                  Docker                         │
│                                                 │
│              app-network                        │
│                                                 │
│   ┌────────────────────┐                        │
│   │        API         │                        │
│   │                    │                        │
│   │ Node.js            │                        │
│   │ Express            │                        │
│   │ dist/              │                        │
│   │                    │                        │
│   │ :3000              │                        │
│   └─────────┬──────────┘                        │
│             │                                   │
│             │ postgres:5432                     │
│             ▼                                   │
│   ┌────────────────────┐                        │
│   │     PostgreSQL     │                        │
│   │                    │                        │
│   │ database           │                        │
│   │ production_        │                        │
│   │ intelligence       │                        │
│   └─────────┬──────────┘                        │
│             │                                   │
│             ▼                                   │
│      postgres_data volume                       │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

### 59. Final Request Flow

A *POST /incidents* request now follows:
```
Client
  │
  │ POST /incidents
  ▼
Host :3000
  │
  ▼
Docker port mapping
  │
  ▼
API container
  │
  ▼
Express
  │
  ├── Helmet
  ├── JSON parser
  ├── Request ID
  ├── Request logging
  ├── Rate limiter
  ├── Validation
  │
  ▼
Incident Controller
  │
  ▼
Incident Service
  │
  ▼
Incident Repository
  │
  │ PostgreSQL connection
  ▼
Docker DNS
  │
  │ postgres
  ▼
PostgreSQL container
  │
  ▼
postgres_data
```
This is now a proper containerized backend foundation.

---

### 60. Service Discovery

One of the most important lessons from this lecture is:
```
POSTGRES_HOST=postgres
```
The API does not know:
```
172.20.0.3
```
It does not need to.

It knows:
```
postgres
```
Docker resolves that name.

This is the beginning of service-oriented architecture.

Later we will have names such as:
```
postgres
redis
api
worker
```
and potentially:
```
event-bus
```
The services communicate using stable service names rather than hardcoded IP addresses.

---

### 61. Database Persistence

Our architecture now separates:
```
Compute
```
from:
```
Storage
```
Container:
```
postgres
```
Storage:
```
postgres_data
```
Therefore:
```
PostgreSQL container
       │
       ▼
Persistent volume
```
This principle becomes very important when we later introduce:
```
Redis
BullMQ
background workers
```

---

### 62. Health Architecture

We now have three levels of health.

#### Application liveness
```
/health/live
```
Answers:
```
Is Node.js alive?
```

---

#### Application readiness
```
/health/ready
```
Answers:
```
Can the API communicate with PostgreSQL?
```

---

#### Docker container health
```
HEALTHCHECK
```
Answers:
```
Is the container's HTTP application responding?
```

---
#### PostgreSQL health
```
pg_isready
```
Answers:
```
Is PostgreSQL accepting connections?
```
So:
```
Docker
 │
 ├── PostgreSQL health
 │
 └── API health
       │
       └── application readiness
```
This is much stronger than simply checking whether a process exists.

---

### 63. Restart Behavior

We added:
```
restart: unless-stopped
```
This means Docker can restart a container when it exits unexpectedly.

For example:
```
API process crashes
       │
       ▼
Docker detects exit
       │
       ▼
Docker restarts container
```
However:

*Restart policies are not a substitute for fixing application failures.*

We still need:

- good error handling
- logging
- health checks
- readiness
- graceful shutdown
- observability

---

### 64. What depends_on Does Not Mean

This is an important interview concept.

This:
```
depends_on:
  postgres:
    condition: service_healthy
```
means:
```
Start API after PostgreSQL becomes healthy
```
It does **not** mean:
```
PostgreSQL will never fail
```
It does **not** mean:
```
API will automatically reconnect forever
```
It does **not** mean:
```
network failures cannot happen
```
It only addresses startup ordering.

---

### 65. Intentional Failure Matrix

We have now tested:
| Failure               |       Liveness |      Readiness | Expected |
| --------------------- | -------------: | -------------: | -------- |
| API healthy           |            200 |            200 | Normal   |
| PostgreSQL stopped    |            200 |            503 | Correct  |
| Wrong PostgreSQL host |            200 |            503 | Correct  |
| Wrong DB password     |            200 |            503 | Correct  |
| API stopped           |    No response |    No response | Correct  |
| PostgreSQL restarted  |            200 | eventually 200 | Recovery |
| API restarted         | eventually 200 | eventually 200 | Recovery |

This is the kind of behavior we want from a production service.

---

### 66. Final Folder Structure
```
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
│   │   │   ├── 001_create_incidents.sql
│   │   │   ├── 002_create_incident_events.sql
│   │   │   ├── 003_add_incident_indexes.sql
│   │   │   ├── 004_add_incident_acknowledged_at.sql
│   │   │   ├── 005_add_incident_domain_constraints.sql
│   │   │   └── 006_add_incident_event_constraints.sql
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