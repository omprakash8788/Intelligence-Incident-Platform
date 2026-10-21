import type {
  PoolClient
} from "pg";

import { pool } from "../database/pool.js";

export interface IdempotencyInput {
  idempotencyKey: string;
  requestHash: string;
}

export interface IdempotencyResult<T> {
  replayed: boolean;
  result: T;
}

interface StoredIdempotencyRecord {
  request_hash: string;
  response: TJsonValue;
}

type TJsonValue =
  | string
  | number
  | boolean
  | null
  | TJsonValue[]
  | { [key: string]: TJsonValue };

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super(
      "Idempotency key was already used with a different request"
    );

    this.name = "IdempotencyKeyConflictError";
  }
}

const validateInput = (
  input: IdempotencyInput
): void => {
  if (input.idempotencyKey.trim().length === 0) {
    throw new Error(
      "idempotencyKey must not be empty"
    );
  }

  if (input.requestHash.trim().length === 0) {
    throw new Error(
      "requestHash must not be empty"
    );
  }
};

export const executeIdempotently = async <T extends TJsonValue>(
  input: IdempotencyInput,
  operation: (client: PoolClient) => Promise<T>
): Promise<IdempotencyResult<T>> => {
  validateInput(input);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const insertResult = await client.query(
      `
        INSERT INTO idempotency_records (
          idempotency_key,
          request_hash,
          response
        )
        VALUES ($1, $2, 'null'::jsonb)
        ON CONFLICT (idempotency_key)
        DO NOTHING
        RETURNING idempotency_key
      `,
      [
        input.idempotencyKey,
        input.requestHash
      ]
    );

    if (insertResult.rowCount === 0) {
      const existingResult =
        await client.query<StoredIdempotencyRecord>(
          `
            SELECT
              request_hash,
              response
            FROM idempotency_records
            WHERE idempotency_key = $1
          `,
          [input.idempotencyKey]
        );

      if (existingResult.rowCount !== 1) {
        throw new Error(
          "Idempotency record was not found after conflict"
        );
      }

      const existing = existingResult.rows[0];

      if (existing.request_hash !== input.requestHash) {
        throw new IdempotencyKeyConflictError();
      }

      if (existing.response === null) {
        throw new Error(
          "Stored idempotency response is unexpectedly null"
        );
      }

      await client.query("COMMIT");

      return {
        replayed: true,
        result: existing.response as T
      };
    }

    const result = await operation(client);

    await client.query(
      `
        UPDATE idempotency_records
        SET response = $2::jsonb
        WHERE idempotency_key = $1
      `,
      [
        input.idempotencyKey,
        JSON.stringify(result)
      ]
    );

    await client.query("COMMIT");

    return {
      replayed: false,
      result
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original operation error.
    }

    throw error;
  } finally {
    client.release();
  }
};