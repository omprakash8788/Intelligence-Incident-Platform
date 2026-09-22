import "dotenv/config";

const port = Number(process.env.PORT);
const postgresPort = Number(process.env.POSTGRES_PORT);

const nodeEnv = process.env.NODE_ENV ?? "development";

const allowedEnvironments = [
  "development",
  "test",
  "production"
];

if (!allowedEnvironments.includes(nodeEnv)) {
  throw new Error(
    `Invalid NODE_ENV: ${nodeEnv}`
  );
}

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(
    "PORT must be a positive integer"
  );
}

if (
  !Number.isInteger(postgresPort) ||
  postgresPort <= 0
) {
  throw new Error(
    "POSTGRES_PORT must be a positive integer"
  );
}

const required = {
  POSTGRES_HOST: process.env.POSTGRES_HOST,
  POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
  POSTGRES_USER: process.env.POSTGRES_USER,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD
};

for (const [key, value] of Object.entries(required)) {
  if (!value) {
    throw new Error(
      `${key} environment variable is required`
    );
  }
}

export const env = {
  nodeEnv,
  port,

  postgres: {
    host: required.POSTGRES_HOST,
    port: postgresPort,
    database: required.POSTGRES_DATABASE,
    user: required.POSTGRES_USER,
    password: required.POSTGRES_PASSWORD
  }
} as const;