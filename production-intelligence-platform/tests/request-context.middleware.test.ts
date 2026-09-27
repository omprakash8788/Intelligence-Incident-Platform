import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach
} from "vitest";

import {
  requestContextMiddleware
} from "../src/middleware/request-context.middleware.js";

import {
  getRequestId
} from "../src/logging/request-context.js";

describe(
  "requestContextMiddleware",
  () => {

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it(
      "should preserve a valid incoming request ID",
      () => {

        const req = {
          header: vi.fn()
            .mockReturnValue(
              "client-request-123"
            )
        };

        const headers:
          Record<string, string> = {};

        const res = {
          setHeader: vi.fn(
            (
              name: string,
              value: string
            ) => {
              headers[name] = value;
            }
          )
        };

        const next = vi.fn();

        requestContextMiddleware(
          req as any,
          res as any,
          next
        );

        expect(
          next
        ).toHaveBeenCalledTimes(1);

        expect(
          headers["X-Request-ID"]
        ).toBe(
          "client-request-123"
        );
      }
    );

    it(
      "should generate a request ID when none is provided",
      () => {

        const req = {
          header: vi.fn()
            .mockReturnValue(
              undefined
            )
        };

        const headers:
          Record<string, string> = {};

        const res = {
          setHeader: vi.fn(
            (
              name: string,
              value: string
            ) => {
              headers[name] = value;
            }
          )
        };

        const next = vi.fn();

        requestContextMiddleware(
          req as any,
          res as any,
          next
        );

        expect(
          next
        ).toHaveBeenCalledTimes(1);

        expect(
          headers["X-Request-ID"]
        ).toBeDefined();

        expect(
          headers["X-Request-ID"].length
        ).toBeGreaterThan(0);
      }
    );
  }
);

