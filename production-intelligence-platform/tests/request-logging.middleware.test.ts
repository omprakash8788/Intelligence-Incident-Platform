import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach
} from "vitest";

import {
  requestLoggingMiddleware
} from "../src/middleware/request-logging.middleware.js";

import { logger } from "../src/logging/logger.js";

describe(
  "requestLoggingMiddleware",
  () => {

    beforeEach(() => {
      vi.spyOn(
        logger,
        "info"
      ).mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "should log completed HTTP requests",
      () => {

        const finishHandlers: (() => void)[] = [];

        const req = {
          method: "GET",
          originalUrl: "/health"
        };

        const res = {
          statusCode: 200,

          on: vi.fn(
            (
              event: string,
              callback: () => void
            ) => {

              if (
                event === "finish"
              ) {
                finishHandlers.push(
                  callback
                );
              }

              return res;
            }
          )
        };

        const next = vi.fn();

        requestLoggingMiddleware(
          req as any,
          res as any,
          next
        );

        expect(next)
          .toHaveBeenCalledTimes(1);

        expect(
          finishHandlers
        ).toHaveLength(1);

        finishHandlers[0]();

        expect(
          logger.info
        ).toHaveBeenCalledWith(
          "HTTP request completed",
          expect.objectContaining({
            method: "GET",
            path: "/health",
            statusCode: 200
          })
        );
      }
    );
  }
);