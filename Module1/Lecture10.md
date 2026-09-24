### Lecture 10
### Dependency Injection + Proper Testing Architecture

We are now moving to Lecture 10. This is an important architectural step because our current project has one problem:

```
const incidentRepository = new IncidentRepository();
const incidentService = new IncidentService(incidentRepository);

```


Dependencies are being created `inside the controller module`. That makes testing harder and couples our business logic to concrete implementations.

Today we will fix that using `manual Dependency Injection (DI)` — no DI framework.

### What we will build

```
Composition Root
      │
      ├── IncidentRepository
      │        ↓
      ├── IncidentEventRepository
      │        ↓
      └── IncidentService
               ↓
          IncidentController
               ↓
             Routes
```

And our tests will become:

```
Unit Tests
   ↓
Mocks / Fakes
   ↓
No PostgreSQL

Integration Tests
   ↓
Express + PostgreSQL
   ↓
Real behavior
```

---

### Part 1 — What is Dependency Injection?

Suppose we currently have:

```
export class IncidentService {
  constructor(
    private readonly incidentRepository: IncidentRepository
  ) {}
}

```

This is already DI.

The service says:

 - "I need an incident repository. Whoever creates me should provide it."

That's good.

But our controller currently does this:

```

const incidentRepository = new IncidentRepository();

const incidentService =
  new IncidentService(incidentRepository);

```

The controller is deciding ***which implementation to use.***

That's what we want to remove.

---

### Part 2 — Why DI matters

Imagine we want to test:
```
IncidentService.createIncident()
```

Our current implementation requires PostgreSQL.

That's not ideal for a unit test.

We want to be able to say:
```
const fakeRepository = {
  create: vi.fn()
};
```

and then:
```
const service = new IncidentService(fakeRepository);
```
Now:
```
IncidentService
      ↓
Fake Repository
      ↓
No PostgreSQL
```

This gives us fast, deterministic unit tests.

---

### Part 3 — Create repository interfaces

Create:
```
src/repositories/incident.repository.interface.ts
```

Add:

```
import type { Incident, IncidentSeverity, IncidentStatus } from "../domain/incident.js";
import type { PoolClient } from "pg";

export interface CreateIncidentData {
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
}

export interface IncidentRepositoryContract {
  create(data: CreateIncidentData): Promise<Incident>;

  findById(id: string): Promise<Incident | null>;

  createWithClient(
    client: PoolClient,
    data: CreateIncidentData
  ): Promise<Incident>;
}

```

Now our service doesn't have to depend directly on:
```
IncidentRepository
```

It can depend on:
```
IncidentRepositoryContract
```
That's an important distinction.

---

### Part 4 — Update IncidentRepository

Open:
```
src/repositories/incident.repository.ts
```

Make the class implement the interface:

```
import type { PoolClient } from "pg";
import { pool } from "../database/pool.js";
import type { Incident } from "../domain/incident.js";
import type {
  CreateIncidentData,
  IncidentRepositoryContract
} from "./incident.repository.interface.js";

export class IncidentRepository
  implements IncidentRepositoryContract {

  async create(
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

    const result = await pool.query(query, [
      data.service,
      data.severity,
      data.status
    ]);

    return {
      id: result.rows[0].id,
      service: result.rows[0].service,
      severity: result.rows[0].severity,
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at
    };
  }

  async findById(
    id: string
  ): Promise<Incident | null> {

    const query = `
      SELECT
        id,
        service,
        severity,
        status,
        created_at,
        updated_at
      FROM incidents
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

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
}
```

The important part is:
```
implements IncidentRepositoryContract
```

---

### Part 5 — Event repository interface

Create:
```
src/repositories/incident-event.repository.interface.ts

```

```
import type { PoolClient } from "pg";

export interface CreateIncidentEventData {
  incidentId: string;
  eventType: string;
}

export interface IncidentEventRepositoryContract {
  create(
    client: PoolClient,
    data: CreateIncidentEventData
  ): Promise<unknown>;
}

```

Then update:


```

src/repositories/incident-event.repository.ts

```

```
import type { PoolClient } from "pg";
import type {
  CreateIncidentEventData,
  IncidentEventRepositoryContract
} from "./incident-event.repository.interface.js";

export class IncidentEventRepository
  implements IncidentEventRepositoryContract {

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

---

### Part 6 — Inject both repositories into the service

Now modify:
```
src/services/incident.service.ts
```

The important change is the constructor.

```
import type {
  Incident,
  IncidentSeverity
} from "../domain/incident.js";

import { NotFoundError } from "../errors/NotFoundError.js";
import { withTransaction } from "../database/transaction.js";

import type {
  IncidentRepositoryContract
} from "../repositories/incident.repository.interface.js";

import type {
  IncidentEventRepositoryContract
} from "../repositories/incident-event.repository.interface.js";

interface CreateIncidentInput {
  service: string;
  severity: IncidentSeverity;
}

export class IncidentService {

  constructor(
    private readonly incidentRepository: IncidentRepositoryContract,
    private readonly incidentEventRepository: IncidentEventRepositoryContract
  ) {}

  async createIncident(
    input: CreateIncidentInput
  ): Promise<Incident> {

    return this.incidentRepository.create({
      service: input.service,
      severity: input.severity,
      status: "detected"
    });
  }

  async getIncidentById(
    id: string
  ): Promise<Incident> {

    const incident =
      await this.incidentRepository.findById(id);

    if (!incident) {
      throw new NotFoundError(
        "Incident not found",
        "INCIDENT_NOT_FOUND"
      );
    }

    return incident;
  }

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

      await this.incidentEventRepository.create(
        client,
        {
          incidentId: incident.id,
          eventType: "INCIDENT_CREATED"
        }
      );

      return incident;
    });
  }
}
```

Notice something important.

We removed:

```
const incidentEventRepository =
  new IncidentEventRepository();
```

from the service.

The service doesn't construct its dependencies anymore.

---

### Part 7 — Create the application composition root

Create:
```
src/container.ts
```

This is where we decide which concrete implementations are used.
```
import { IncidentRepository } from "./repositories/incident.repository.js";
import { IncidentEventRepository } from "./repositories/incident-event.repository.js";
import { IncidentService } from "./services/incident.service.js";

const incidentRepository =
  new IncidentRepository();

const incidentEventRepository =
  new IncidentEventRepository();

export const incidentService =
  new IncidentService(
    incidentRepository,
    incidentEventRepository
  );

```

This file is our ***composition root.***

Its responsibility is:

- Construct the application's real dependencies.

This is a very useful production architecture concept.

---

### Part 8 — Controller uses injected service

Now change:

```
src/controllers/incident.controller.ts
```

Instead of creating everything inside the controller, we import the already-created service.

```
import {
  Request,
  Response,
  NextFunction
} from "express";

import { incidentService } from "../container.js";

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

export const getIncidentById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    const incident =
      await incidentService.getIncidentById(
        req.params.id
      );

    res.status(200).json({
      success: true,
      data: incident
    });

  } catch (error) {
    next(error);
  }
};
```

Now:

```
Controller
    ↓
IncidentService
    ↓
Repository interfaces
    ↓
Concrete repositories

```

The controller no longer knows how repositories are constructed.

---

### Part 9 — Now the important part: unit testing

Create:
```
tests/services/incident.service.test.ts
```

We will test the service **without PostgreSQL.**

```
import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import { IncidentService } from "../../src/services/incident.service.js";
import { NotFoundError } from "../../src/errors/NotFoundError.js";

describe("IncidentService", () => {

  it("should throw when incident does not exist", async () => {

    const incidentRepository = {
      findById: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      createWithClient: vi.fn()
    };

    const incidentEventRepository = {
      create: vi.fn()
    };

    const service = new IncidentService(
      incidentRepository,
      incidentEventRepository
    );

    await expect(
      service.getIncidentById("incident-123")
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(
      incidentRepository.findById
    ).toHaveBeenCalledWith("incident-123");
  });

});
```

Run:

```
npm run test:run
```

This test does **not** need PostgreSQL.

That's the power of DI.

---

### Part 10 — One important architecture rule

From now on:

### Don't do this inside business classes

```
const repository =
  new IncidentRepository();

```

### Don't do this

```
const service =
  new IncidentService(...);
```



inside every controller.

✅ **Do this**

Construct dependencies at the application's composition root:
```
container.ts

```

Then inject them.

---





