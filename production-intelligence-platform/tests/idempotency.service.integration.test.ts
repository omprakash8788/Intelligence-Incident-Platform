import {
  afterAll,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { pool } from "../src/database/pool.js";

import {
  executeIdempotently,
  IdempotencyKeyConflictError
} from "../src/services/idempotency.service.js";

const enabled =
  process.env.RUN_POSTGRES_INTEGRATION === "true";

describe.skipIf(!enabled)(
  "PostgreSQL idempotency integration tests",
  () => {
    afterAll(async () => {
      await pool.query(
        `
          DELETE FROM idempotency_records
          WHERE idempotency_key LIKE 'lecture-15:%'
        `
      );
    });

    it("executes the operation once and replays its result", async () => {
      const idempotencyKey =
        "lecture-15:replay-test";

      const operation = vi.fn(async () => ({
        orderId: "order-100",
        status: "created"
      }));

      const first = await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-order-100"
        },
        async () => operation()
      );

      const second = await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-order-100"
        },
        async () => operation()
      );

      expect(first).toEqual({
        replayed: false,
        result: {
          orderId: "order-100",
          status: "created"
        }
      });

      expect(second).toEqual({
        replayed: true,
        result: {
          orderId: "order-100",
          status: "created"
        }
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("rejects reuse of a key with a different request hash", async () => {
      const idempotencyKey =
        "lecture-15:hash-conflict";

      await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-request-A"
        },
        async () => ({
          result: "request-A"
        })
      );

      await expect(
        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-request-B"
          },
          async () => ({
            result: "request-B"
          })
        )
      ).rejects.toBeInstanceOf(
        IdempotencyKeyConflictError
      );
    });

    it("executes the operation once for concurrent duplicate requests", async () => {
      const idempotencyKey =
        "lecture-15:concurrent-test";

      let executions = 0;

      const operation = async () => {
        executions += 1;

        // Simulate asynchronous work inside the transaction.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });

        return {
          operationId: "operation-200",
          status: "completed"
        };
      };

      const [first, second] = await Promise.all([
        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-concurrent"
          },
          operation
        ),

        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-concurrent"
          },
          operation
        )
      ]);

      expect(executions).toBe(1);

      expect(
        [first.replayed, second.replayed].sort()
      ).toEqual([false, true]);

      expect(first.result).toEqual(second.result);
    });

    it("allows a retry after the first transaction rolls back", async () => {
      const idempotencyKey =
        "lecture-15:rollback-test";

      const firstOperation = vi.fn(async () => {
        throw new Error("Simulated operation failure");
      });

      await expect(
        executeIdempotently(
          {
            idempotencyKey,
            requestHash: "hash-rollback"
          },
          firstOperation
        )
      ).rejects.toThrow(
        "Simulated operation failure"
      );

      const retry = await executeIdempotently(
        {
          idempotencyKey,
          requestHash: "hash-rollback"
        },
        async () => ({
          result: "successful-retry"
        })
      );

      expect(retry).toEqual({
        replayed: false,
        result: {
          result: "successful-retry"
        }
      });

      expect(firstOperation).toHaveBeenCalledTimes(1);
    });
  }
);