### 1. First verify Redis itself
Run:
```
docker compose ps
```

You should have
```
production-intelligence-postgres   healthy
production-intelligence-redis      healthy
production-intelligence-api        healthy
```

Then:
```
docker compose exec redis redis-cli ping
```
Expected:
```
PONG
```

If you get `PONG`, Redis itself is fine.

### 2. Verify your source code
```
File: src/server.ts
```
Make sure your actual file contains

```
import { createServer } from "node:http";

import app from "./app.js";

import { env } from "./config/env.js";

import { logger } from "./logging/logger.js";

import {
  markApplicationReady
} from "./server/lifecycle.js";

import {
  shutdown
} from "./server/shutdown.js";

import {
  connectRedis
} from "./redis/lifecycle.js";

const server =
  createServer(app);

const start =
  async (): Promise<void> => {
    try {
      await connectRedis();

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
    } catch (error) {
      logger.error(
        "Application startup failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      process.exitCode = 1;
    }
  };

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

void start();
```

### The critical line is:
```
await connectRedis();
```

---

### 3. Now rebuild the API image
This is the part that is currently missing.
Run:
```
docker compose build api
```

Wait for it to finish successfully.
Then recreate the API container:
```
docker compose up -d --force-recreate api
```

Check:
```
docker compose ps
```

---

### 6. Now check the logs
Run:
```
docker compose logs api --tail 50
```

Your log JSON should look similar to:

{"level":"info","message":"Redis connected","metadata":{"host":"redis","port":6379}}



### Run these in this exact order:
```
npm run build
```

```
docker compose build api
```

```
docker compose up -d --force-recreate api
```
```

docker compose exec api printenv REDIS_HOST
```

```

docker compose exec redis redis-cli ping
```

```
docker compose logs api --tail 50
```

The two critical outputs we want are:
```
redis
```

and:

```
PONG
```

and finally in API logs:
```
Redis connected
Server started
```

