import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationsDirectory =
  path.join(__dirname, "migrations");

const runMigrations = async () => {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = await fs.readdir(
      migrationsDirectory
    );

    const migrationFiles = files
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const result = await client.query(`
      SELECT version
      FROM schema_migrations
    `);

    const appliedMigrations =
      new Set(
        result.rows.map(
          (row) => row.version
        )
      );

    for (const file of migrationFiles) {

      const version = file.replace(
        ".sql",
        ""
      );

      if (appliedMigrations.has(version)) {
        continue;
      }

      console.log(
        `Running migration: ${version}`
      );

      const sql = await fs.readFile(
        path.join(
          migrationsDirectory,
          file
        ),
        "utf-8"
      );

      await client.query("BEGIN");

      try {
        await client.query(sql);

        await client.query(
          `
            INSERT INTO schema_migrations (
              version
            )
            VALUES ($1)
          `,
          [version]
        );

        await client.query("COMMIT");

        console.log(
          `Migration completed: ${version}`
        );

      } catch (error) {

        await client.query("ROLLBACK");

        throw error;
      }
    }

    console.log(
      "Database migrations completed."
    );

  } finally {
    client.release();
    await pool.end();
  }
};

runMigrations().catch((error) => {
  console.error(
    "Migration failed:",
    error
  );

  process.exit(1);
});