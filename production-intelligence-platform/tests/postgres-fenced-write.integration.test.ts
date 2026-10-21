import {
  afterAll,
  describe,
  expect,
  it
} from "vitest";

import { pool } from "../src/database/pool.js";

import {
  writeFencedResource
} from "../src/services/postgres-fenced-write.service.js";

const runPostgresIntegrationTests =
  process.env.RUN_POSTGRES_INTEGRATION === "true";

describe.skipIf(!runPostgresIntegrationTests)(
  "PostgreSQL fenced-write integration tests",
  () => {
    const resourceId =
      "lecture-12-concurrent-demo";

    afterAll(async () => {
      await pool.query(
        `
          DELETE FROM lecture11_fenced_resources
          WHERE resource_id = $1
        `,
        [resourceId]
      );
    });

    it(
      "preserves the higher fencing token under concurrent writes",
      async () => {
        await pool.query(
          `
            DELETE FROM lecture11_fenced_resources
            WHERE resource_id = $1
          `,
          [resourceId]
        );

        const results = await Promise.all([
          writeFencedResource({
            resourceId,
            fencingToken: 41,
            value: "old-leader-result"
          }),

          writeFencedResource({
            resourceId,
            fencingToken: 42,
            value: "new-leader-result"
          })
        ]);

        expect(results).toHaveLength(2);

        const finalState = await pool.query<{
          resource_id: string;
          highest_token: string;
          value: string;
        }>(
          `
            SELECT
              resource_id,
              highest_token,
              value
            FROM lecture11_fenced_resources
            WHERE resource_id = $1
          `,
          [resourceId]
        );

        expect(finalState.rowCount).toBe(1);

        expect(finalState.rows[0]).toEqual({
          resource_id: resourceId,
          highest_token: "42",
          value: "new-leader-result"
        });
      }
    );

    it(
      "rejects a stale write after the newer leader has written",
      async () => {
        const staleScenarioId =
          "lecture-12-stale-leader-demo";

        try {
          await pool.query(
            `
              DELETE FROM lecture11_fenced_resources
              WHERE resource_id = $1
            `,
            [staleScenarioId]
          );

          const newerLeader = await writeFencedResource({
            resourceId: staleScenarioId,
            fencingToken: 42,
            value: "new-leader-result"
          });

          expect(newerLeader.accepted).toBe(true);

          const staleLeader = await writeFencedResource({
            resourceId: staleScenarioId,
            fencingToken: 41,
            value: "old-leader-result"
          });

          expect(staleLeader.accepted).toBe(false);

          const finalState = await pool.query<{
            highest_token: string;
            value: string;
          }>(
            `
              SELECT
                highest_token,
                value
              FROM lecture11_fenced_resources
              WHERE resource_id = $1
            `,
            [staleScenarioId]
          );

          expect(finalState.rowCount).toBe(1);

          expect(finalState.rows[0]).toEqual({
            highest_token: "42",
            value: "new-leader-result"
          });
        } finally {
          await pool.query(
            `
              DELETE FROM lecture11_fenced_resources
              WHERE resource_id = $1
            `,
            [staleScenarioId]
          );
        }
      }
    );
  }
);