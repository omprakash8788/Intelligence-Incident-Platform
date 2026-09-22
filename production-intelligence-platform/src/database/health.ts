import { pool } from "./pool.js";

export const checkDatabaseConnection = async () => {
  const result = await pool.query("SELECT 1");

  return result.rows[0];
};

