import { pool } from "../database/pool.js";

export interface FencedWriteInput {
  resourceId: string;
  fencingToken: number;
  value: string;
}

export interface FencedWriteResult {
  accepted: boolean;
  resourceId: string;
  highestToken: string;
  value: string;
}

interface FencedResourceRow {
  resource_id: string;
  highest_token: string;
  value: string;
}

export const writeFencedResource = async (
  input: FencedWriteInput
): Promise<FencedWriteResult> => {
  const {
    resourceId,
    fencingToken,
    value
  } = input;

  if (resourceId.trim().length === 0) {
    throw new Error("resourceId must not be empty");
  }

  if (
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 1
  ) {
    throw new Error(
      "fencingToken must be a positive safe integer"
    );
  }

  const result = await pool.query<FencedResourceRow>(
    `
      INSERT INTO lecture11_fenced_resources (
        resource_id,
        highest_token,
        value
      )
      VALUES ($1, $2, $3)

      ON CONFLICT (resource_id)
      DO UPDATE SET
        highest_token = EXCLUDED.highest_token,
        value = EXCLUDED.value

      WHERE
        EXCLUDED.highest_token
          >= lecture11_fenced_resources.highest_token

      RETURNING
        resource_id,
        highest_token,
        value
    `,
    [
      resourceId,
      fencingToken,
      value
    ]
  );

  if (result.rowCount === 0) {
    const current = await pool.query<{
      highest_token: string;
    }>(
      `
        SELECT highest_token
        FROM lecture11_fenced_resources
        WHERE resource_id = $1
      `,
      [resourceId]
    );

    if (current.rowCount === 0) {
      throw new Error(
        "Resource disappeared after fenced write rejection"
      );
    }

    return {
      accepted: false,
      resourceId,
      highestToken: current.rows[0].highest_token,
      value
    };
  }

  const row = result.rows[0];

  return {
    accepted: true,
    resourceId: row.resource_id,
    highestToken: row.highest_token,
    value: row.value
  };
};