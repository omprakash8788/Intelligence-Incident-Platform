import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = new Pool({
  host: env.postgres.host,
  port: env.postgres.port,
  database: env.postgres.database,
  user: env.postgres.user,
  password: env.postgres.password,

  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});