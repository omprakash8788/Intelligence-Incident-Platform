import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "../database/pool.js";

export interface IdempotentEffectInput {
  idempotencyKey: string;
  message: string;
}

export interface IdempotentEffectResult {
  effectId: string;
  idempotencyKey: string;
  message: string;
  created: boolean;
}

interface StoredResult {
  effectId: string;
  idempotencyKey: string;
  message: string;
}

const MAX_KEY_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 500;

const validateInput = (
  input: IdempotentEffectInput
): void => {
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0 ||
    input.idempotencyKey.length > MAX_KEY_LENGTH
  ) {
    throw new TypeError(
      `Idempotency key must contain 1 to ${MAX_KEY_LENGTH} characters`
    );
  }

  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new TypeError(
      `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`
    );
  }
};

const hashPayload = (message: string): string => {
  return createHash("sha256")
    .update(JSON.stringify({ message }))
    .digest("hex");
};

export const recordIdempotentEffect = async (
  input: IdempotentEffectInput
): Promise<IdempotentEffectResult> => {
  validateInput(input);

  const idempotencyKey = input.idempotencyKey.trim();
  const message = input.message.trim();
  const payloadHash = hashPayload(message);

  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const insertRecord = await client.query(
      `
        INSERT INTO idempotency_effects (
          idempotency_key,
          payload_hash,
          result
        )
        VALUES ($1, $2, '{}'::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `,
      [idempotencyKey, payloadHash]
    );

    if (insertRecord.rowCount === 0) {
      const existingRecord = await client.query<{
        payload_hash: string;
        result: StoredResult;
      }>(
        `
          SELECT payload_hash, result
          FROM idempotency_effects
          WHERE idempotency_key = $1
        `,
        [idempotencyKey]
      );

      const existing = existingRecord.rows[0];

      if (!existing) {
        throw new Error(
          "Idempotency record was not found after conflict"
        );
      }

      if (existing.payload_hash !== payloadHash) {
        throw new Error(
          "Idempotency key was reused with a different payload"
        );
      }

      const storedResult = existing.result;

      await client.query("COMMIT");

      return {
        ...storedResult,
        created: false
      };
    }

    const effectId = randomUUID();

    await client.query(
      `
        INSERT INTO business_effects (
          effect_id,
          idempotency_key,
          message
        )
        VALUES ($1, $2, $3)
      `,
      [effectId, idempotencyKey, message]
    );

    const result: StoredResult = {
      effectId,
      idempotencyKey,
      message
    };

    await client.query(
      `
        UPDATE idempotency_effects
        SET result = $2::jsonb
        WHERE idempotency_key = $1
      `,
      [idempotencyKey, JSON.stringify(result)]
    );

    await client.query("COMMIT");

    return {
      ...result,
      created: true
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }

    throw error;
  } finally {
    client.release();
  }
};