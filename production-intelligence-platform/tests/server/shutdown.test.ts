import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach
} from "vitest";

import {
  shutdown
} from "../../src/server/shutdown.js";

import {
  pool
} from "../../src/database/pool.js";

import {
  logger
} from "../../src/logging/logger.js";

describe(
  "shutdown",
  () => {

    beforeEach(() => {

      vi.spyOn(
        logger,
        "info"
      ).mockImplementation(
        () => {}
      );

      vi.spyOn(
        logger,
        "warn"
      ).mockImplementation(
        () => {}
      );

      vi.spyOn(
        logger,
        "error"
      ).mockImplementation(
        () => {}
      );

      vi.spyOn(
        pool,
        "end"
      ).mockResolvedValue();

      vi.spyOn(
        process,
        "exit"
      ).mockImplementation(
        (() => {}) as never
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "should close the HTTP server and database pool",
      async () => {

        const server = {
          close: vi.fn(
            (
              callback: (
                error?: Error
              ) => void
            ) => {
              callback();
            }
          )
        };

        await shutdown(
          server as any,
          "SIGTERM"
        );

        expect(
          server.close
        ).toHaveBeenCalledTimes(1);

        expect(
          pool.end
        ).toHaveBeenCalledTimes(1);

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "HTTP server closed"
        );

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "PostgreSQL connection pool closed"
        );

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "Graceful shutdown completed"
        );
      }
    );
  }
);

