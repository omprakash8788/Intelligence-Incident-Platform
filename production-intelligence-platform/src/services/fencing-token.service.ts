import { pool } from "../database/pool.js";

export interface FencedWriteResult {
  accepted: boolean;
  resourceKey: string;
  fencingToken: string;
  operationId: string;
}

export class FencingTokenService {
  async allocateToken(
    resourceKey: string
  ): Promise<string> {
    if (!resourceKey.trim()) {
      throw new Error("Resource key is required");
    }

    const result = await pool.query<{ token: string }>(
      `
        INSERT INTO lock_fencing_state (
          resource_key,
          last_token
        )
        VALUES ($1, 1)

        ON CONFLICT (resource_key)
        DO UPDATE SET
          last_token = lock_fencing_state.last_token + 1,
          updated_at = NOW()

        RETURNING last_token::text AS token
      `,
      [resourceKey]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error(
        "Failed to allocate fencing token"
      );
    }

    return row.token;
  }

  async applyFencedWrite(
    resourceKey: string,
    fencingToken: string,
    operationId: string
  ): Promise<FencedWriteResult> {
    if (!resourceKey.trim()) {
      throw new Error("Resource key is required");
    }

    if (!/^[1-9]\d*$/.test(fencingToken)) {
      throw new Error(
        "Fencing token must be a positive integer string"
      );
    }

    if (!operationId.trim()) {
      throw new Error("Operation ID is required");
    }

    const result = await pool.query<{
      resource_key: string;
      fencing_token: string;
      operation_id: string;
    }>(
      `
        INSERT INTO fenced_resource_state (
          resource_key,
          last_fencing_token,
          last_operation_id
        )
        VALUES ($1, $2::bigint, $3)

        ON CONFLICT (resource_key)
        DO UPDATE SET
          last_fencing_token = EXCLUDED.last_fencing_token,
          last_operation_id = EXCLUDED.last_operation_id,
          updated_at = NOW()

        WHERE
          fenced_resource_state.last_fencing_token
          < EXCLUDED.last_fencing_token

        RETURNING
          resource_key,
          last_fencing_token::text AS fencing_token,
          last_operation_id AS operation_id
      `,
      [resourceKey, fencingToken, operationId]
    );

    const row = result.rows[0];

    if (!row) {
      return {
        accepted: false,
        resourceKey,
        fencingToken,
        operationId
      };
    }

    return {
      accepted: true,
      resourceKey: row.resource_key,
      fencingToken: row.fencing_token,
      operationId: row.operation_id
    };
  }
}

export const fencingTokenService =
  new FencingTokenService();