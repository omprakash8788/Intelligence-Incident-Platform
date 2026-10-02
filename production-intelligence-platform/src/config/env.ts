// import "dotenv/config";



// const port = Number(process.env.PORT);
// const postgresPort = Number(process.env.POSTGRES_PORT);

// const nodeEnv = process.env.NODE_ENV ?? "development";

// const allowedEnvironments = [
//   "development",
//   "test",
//   "production"
// ];

// if (!allowedEnvironments.includes(nodeEnv)) {
//   throw new Error(
//     `Invalid NODE_ENV: ${nodeEnv}`
//   );
// }

// if (!Number.isInteger(port) || port <= 0) {
//   throw new Error(
//     "PORT must be a positive integer"
//   );
// }

// if (
//   !Number.isInteger(postgresPort) ||
//   postgresPort <= 0
// ) {
//   throw new Error(
//     "POSTGRES_PORT must be a positive integer"
//   );
// }

// const required = {
//   POSTGRES_HOST: process.env.POSTGRES_HOST,
//   POSTGRES_DATABASE: process.env.POSTGRES_DATABASE,
//   POSTGRES_USER: process.env.POSTGRES_USER,
//   POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD
// };

// for (const [key, value] of Object.entries(required)) {
//   if (!value) {
//     throw new Error(
//       `${key} environment variable is required`
//     );
//   }
// }

// export const env = {
//   nodeEnv,
//   port,

//   postgres: {
//     host: required.POSTGRES_HOST,
//     port: postgresPort,
//     database: required.POSTGRES_DATABASE,
//     user: required.POSTGRES_USER,
//     password: required.POSTGRES_PASSWORD
//   }
// } as const;


import "dotenv/config";

import type {
  AppConfig,
  NodeEnvironment
} from "./config.types.js";

const parseRequiredString = (
  name: string
): string => {

  const value =
    process.env[name];

  if (
    value === undefined ||
    value.trim() === ""
  ) {
    throw new Error(
      `${name} environment variable is required`
    );
  }

  return value.trim();
};

const parsePositiveInteger = (
  name: string,
  value: string
): number => {

  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer`
    );
  }

  return parsed;
};

const parseEnvironment = (): NodeEnvironment => {

  const value =
    process.env.NODE_ENV ??
    "development";

  const allowed:
    NodeEnvironment[] = [
      "development",
      "test",
      "production"
    ];

  if (
    !allowed.includes(
      value as NodeEnvironment
    )
  ) {
    throw new Error(
      `Invalid NODE_ENV: ${value}`
    );
  }

  return value as NodeEnvironment;
};

const nodeEnv =
  parseEnvironment();

const port =
  parsePositiveInteger(
    "PORT",
    process.env.PORT ?? "3000"
  );

const postgresPort =
  parsePositiveInteger(
    "POSTGRES_PORT",
    process.env.POSTGRES_PORT ??
    "5432"
  );

const postgresHost =
  parseRequiredString(
    "POSTGRES_HOST"
  );

const postgresDatabase =
  parseRequiredString(
    "POSTGRES_DATABASE"
  );

const postgresUser =
  parseRequiredString(
    "POSTGRES_USER"
  );

const postgresPassword =
  parseRequiredString(
    "POSTGRES_PASSWORD"
  );

export const env: AppConfig = {
  app: {
    nodeEnv,
    port
  },

  postgres: {
    host:
      postgresHost,
    port:
      postgresPort,
    database:
      postgresDatabase,
    user:
      postgresUser,
    password:
      postgresPassword
  },

  security: {
    requestBodyLimit:
      "100kb"
  }
};