import helmet from "helmet";

export const securityMiddleware =
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });

  