import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { shutdown } from "./server/shutdown.js";
import {
  markApplicationReady
} from "./server/lifecycle.js";

const server =
  app.listen(
    env.port,
    () => {
       markApplicationReady();
      logger.info(
        "Server started",
        {
          port: env.port,
          environment:
            env.nodeEnv
        }
      );
    }
  );

process.on(
  "SIGINT",
  () => {
    void shutdown(
      server,
      "SIGINT"
    );
  }
);

process.on(
  "SIGTERM",
  () => {
    void shutdown(
      server,
      "SIGTERM"
    );
  }
);

