import express from 'express'
import  healthRoutes from './routes/health.routes.js'
import { errorMiddleware } from './middleware/error.middleware.js';
import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import incidentRoutes from "./routes/incident.routes.js";
import { requestLoggingMiddleware } from './middleware/request-logging.middleware.js';
import {
  requestContextMiddleware
} from "./middleware/request-context.middleware.js";

import {
  securityMiddleware
} from "./middleware/security.middleware.js";

import externalApiRoutes
  from "./routes/external-api.routes.js";

import {
  apiRateLimiter
} from "./config/rate-limit.js";

import demoQueueRoutes
  from "./routes/demo-queue.routes.js";

import queueMonitoringRoutes
  from "./routes/queue-monitoring.routes.js";

const app = express();

app.use(
  securityMiddleware
);

// app.use(express.json());
app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(requestContextMiddleware);
app.use(queueMonitoringRoutes);
app.use(requestLoggingMiddleware);
app.use(externalApiRoutes);

// app.use(
//   apiRateLimiter
// );

app.use(
  demoQueueRoutes
);

app.use("/health",  healthRoutes)
app.use("/incidents", apiRateLimiter ,incidentRoutes);

app.use(notFoundMiddleware)

app.use(errorMiddleware)

export default app;



