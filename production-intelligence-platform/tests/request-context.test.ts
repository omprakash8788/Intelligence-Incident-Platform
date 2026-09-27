import {
  describe,
  expect,
  it
} from "vitest";

import {
  getRequestId,
  runWithRequestContext
} from "../src/logging/request-context.js";

describe(
  "request context",
  () => {

    it(
      "should expose the request ID inside the context",
      () => {

        let requestId:
          string | undefined;

        runWithRequestContext(
          {
            requestId:
              "request-123"
          },
          () => {

            requestId =
              getRequestId();
          }
        );

        expect(requestId)
          .toBe("request-123");
      }
    );

    it(
  "should preserve the request ID across async operations",
  async () => {

    let requestId:
      string | undefined;

    await runWithRequestContext(
      {
        requestId:
          "request-async-123"
      },
      async () => {

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              10
            )
        );

        requestId =
          getRequestId();
      }
    );

    expect(requestId)
      .toBe(
        "request-async-123"
      );
  }
);

    it(
      "should return undefined outside a request context",
      () => {

        expect(
          getRequestId()
        ).toBeUndefined();
      }
    );
  }
);

