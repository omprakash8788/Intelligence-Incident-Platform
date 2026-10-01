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


import {
  apiRateLimiter
} from "./config/rate-limit.js";

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

app.use(requestLoggingMiddleware);

// app.use(
//   apiRateLimiter
// );

app.use("/health",  healthRoutes)
app.use("/incidents", apiRateLimiter ,incidentRoutes);

app.use(notFoundMiddleware)

app.use(errorMiddleware)

export default app;



