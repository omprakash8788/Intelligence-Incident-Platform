import type {
  PoolClient
} from "pg";

import { randomUUID } from "node:crypto";

import { pool } from "../database/pool.js";

export interface OutboxEventInput {
  eventId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxTransactionResult<T> {
  result: T;
  eventId: string;
}

export const executeWithOutbox = async <T>(
  operation: (
    client: PoolClient
  ) => Promise<T>,
  event: OutboxEventInput
): Promise<OutboxTransactionResult<T>> => {
  if (event.eventType.trim().length === 0) {
    throw new Error(
      "eventType must not be empty"
    );
  }

  const eventId = event.eventId ?? randomUUID();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await operation(client);

    await client.query(
      `
        INSERT INTO transactional_outbox (
          event_id,
          event_type,
          payload
        )
        VALUES ($1, $2, $3::jsonb)
      `,
      [
        eventId,
        event.eventType,
        JSON.stringify(event.payload)
      ]
    );

    await client.query("COMMIT");

    return {
      result,
      eventId
    };
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
};