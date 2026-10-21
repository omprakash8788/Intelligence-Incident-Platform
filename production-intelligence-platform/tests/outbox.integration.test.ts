import {
  afterAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { pool } from "../src/database/pool.js";

import {
  executeWithOutbox
} from "../src/services/outbox-transaction.service.js";

import {
  OutboxPublisher
} from "../src/services/outbox-publisher.service.js";

const enabled =
  process.env.RUN_POSTGRES_INTEGRATION === "true";

describe.skipIf(!enabled)(
  "Transactional outbox integration tests",
  () => {
    afterAll(async () => {
      await pool.query(
        `
          DELETE FROM transactional_outbox
          WHERE event_type LIKE 'lecture-16.%'
        `
      );
    });

    it(
      "commits the outbox event with the business transaction",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000001";

        const result = await executeWithOutbox(
          async (client) => {
            await client.query(
              `
                SELECT 1
              `
            );

            return {
              orderId: "lecture-16-order-1"
            };
          },
          {
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-1"
            }
          }
        );

        expect(result.result).toEqual({
          orderId: "lecture-16-order-1"
        });

        expect(result.eventId).toBe(eventId);

        const stored = await pool.query(
          `
            SELECT event_id, event_type, payload
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(1);

        expect(stored.rows[0]).toEqual({
          event_id: eventId,
          event_type: "lecture-16.order-created",
          payload: {
            orderId: "lecture-16-order-1"
          }
        });
      }
    );

    it(
      "rolls back the outbox event when the business operation fails",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000002";

        await expect(
          executeWithOutbox(
            async () => {
              throw new Error(
                "Simulated business failure"
              );
            },
            {
              eventId,
              eventType: "lecture-16.order-created",
              payload: {
                orderId: "lecture-16-order-2"
              }
            }
          )
        ).rejects.toThrow(
          "Simulated business failure"
        );

        const stored = await pool.query(
          `
            SELECT event_id
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(0);
      }
    );

    it(
      "publishes an eligible event and marks it published",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000003";

        await pool.query(
          `
            DELETE FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        await executeWithOutbox(
          async () => ({
            orderId: "lecture-16-order-3"
          }),
          {
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-3"
            }
          }
        );

        const publish = vi.fn(
          async () => undefined
        );

        const publisher = new OutboxPublisher(
          {
            publisherId: "lecture-16-publisher-A",
            batchSize: 10,
            claimDurationMs: 30_000
          },
          publish
        );

        const result = await publisher.publishBatch();

        expect(result.claimed).toBeGreaterThanOrEqual(1);
        expect(result.published).toBeGreaterThanOrEqual(1);

        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-3"
            }
          })
        );

        const stored = await pool.query(
          `
            SELECT published_at
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(1);
        expect(stored.rows[0].published_at).not.toBeNull();
      }
    );

    it(
      "releases the claim for a failed publication",
      async () => {
        const eventId =
          "a7160000-0000-4000-8000-000000000004";

        await pool.query(
          `
            DELETE FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        await executeWithOutbox(
          async () => ({
            orderId: "lecture-16-order-4"
          }),
          {
            eventId,
            eventType: "lecture-16.order-created",
            payload: {
              orderId: "lecture-16-order-4"
            }
          }
        );

        const publisher = new OutboxPublisher(
          {
            publisherId: "lecture-16-publisher-B",
            batchSize: 10,
            claimDurationMs: 30_000
          },
          async (event) => {
            if (event.eventId === eventId) {
              throw new Error(
                "Simulated destination failure"
              );
            }
          }
        );

        const result = await publisher.publishBatch();

        expect(result.failed).toBeGreaterThanOrEqual(1);

        const stored = await pool.query(
          `
            SELECT
              published_at,
              locked_by,
              locked_until,
              attempts,
              last_error
            FROM transactional_outbox
            WHERE event_id = $1
          `,
          [eventId]
        );

        expect(stored.rowCount).toBe(1);

        expect(stored.rows[0].published_at).toBeNull();
        expect(stored.rows[0].locked_by).toBeNull();
        expect(stored.rows[0].locked_until).toBeNull();
        expect(stored.rows[0].attempts).toBeGreaterThanOrEqual(1);
        expect(stored.rows[0].last_error).toBe(
          "Simulated destination failure"
        );
      }
    );
  }
);