import express from 'express'
import  healthRoutes from './routes/health.routes.js'
import { errorMiddleware } from './middleware/error.middleware.js';
import { notFoundMiddleware } from './middleware/not-found.middleware.js';
import incidentRoutes from "./routes/incident.routes.js";


const app = express();

app.use(express.json());


app.use("/health",  healthRoutes)
app.use("/incidents", incidentRoutes);

app.use(notFoundMiddleware)

app.use(errorMiddleware)

export default app;

