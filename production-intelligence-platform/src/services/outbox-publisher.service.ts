import { pool } from "../database/pool.js";

export interface OutboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface ClaimedOutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface OutboxPublisherConfig {
  publisherId: string;
  batchSize: number;
  claimDurationMs: number;
}

export type PublishOutboxEvent = (
  event: OutboxEvent
) => Promise<void>;

export class OutboxPublisher {
  constructor(
    private readonly config: OutboxPublisherConfig,
    private readonly publish: PublishOutboxEvent
  ) {
    if (
      config.publisherId.trim().length === 0
    ) {
      throw new Error(
        "publisherId must not be empty"
      );
    }

    if (
      !Number.isSafeInteger(config.batchSize) ||
      config.batchSize < 1
    ) {
      throw new Error(
        "batchSize must be a positive safe integer"
      );
    }

    if (
      !Number.isSafeInteger(config.claimDurationMs) ||
      config.claimDurationMs < 1
    ) {
      throw new Error(
        "claimDurationMs must be a positive safe integer"
      );
    }
  }

  async publishBatch(): Promise<{
    claimed: number;
    published: number;
    failed: number;
  }> {
    const client = await pool.connect();

    let rows: ClaimedOutboxRow[];

    try {
      await client.query("BEGIN");

      const claimResult =
        await client.query<ClaimedOutboxRow>(
          `
            WITH candidates AS (
              SELECT id
              FROM transactional_outbox
              WHERE published_at IS NULL
                AND (
                  locked_until IS NULL
                  OR locked_until < clock_timestamp()
                )
              ORDER BY id
              FOR UPDATE SKIP LOCKED
              LIMIT $1
            )
            UPDATE transactional_outbox AS outbox
            SET
              locked_by = $2,
              locked_until =
                clock_timestamp()
                + ($3::bigint * interval '1 millisecond'),
              attempts = outbox.attempts + 1
            FROM candidates
            WHERE outbox.id = candidates.id
            RETURNING
              outbox.id,
              outbox.event_id,
              outbox.event_type,
              outbox.payload,
              outbox.attempts
          `,
          [
            this.config.batchSize,
            this.config.publisherId,
            this.config.claimDurationMs
          ]
        );

      rows = claimResult.rows;

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }

      throw error;
    } finally {
      client.release();
    }

    let published = 0;
    let failed = 0;

    for (const row of rows) {
      const event: OutboxEvent = {
        id: row.id,
        eventId: row.event_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts
      };

      try {
        await this.publish(event);

        const markResult = await pool.query(
          `
            UPDATE transactional_outbox
            SET
              published_at = clock_timestamp(),
              locked_by = NULL,
              locked_until = NULL,
              last_error = NULL
            WHERE id = $1
              AND locked_by = $2
              AND published_at IS NULL
          `,
          [
            row.id,
            this.config.publisherId
          ]
        );

        if (markResult.rowCount === 1) {
          published += 1;
        } else {
          // Publication may already have happened,
          // but this publisher no longer owns the claim.
          failed += 1;
        }
      } catch (error) {
        failed += 1;

        const message =
          error instanceof Error
            ? error.message
            : "Unknown publication error";

        await pool.query(
          `
            UPDATE transactional_outbox
            SET
              locked_by = NULL,
              locked_until = NULL,
              last_error = $3
            WHERE id = $1
              AND locked_by = $2
              AND published_at IS NULL
          `,
          [
            row.id,
            this.config.publisherId,
            message.slice(0, 2000)
          ]
        );
      }
    }

    return {
      claimed: rows.length,
      published,
      failed
    };
  }
}