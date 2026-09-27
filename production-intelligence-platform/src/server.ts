import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./logging/logger.js";

app.listen(env.port, () => {
  // console.log(`Server running on port ${env.port}`);
  logger.info(
    "Server started",{
      port:env.port,
       environment: env.nodeEnv
    }
  )
});

