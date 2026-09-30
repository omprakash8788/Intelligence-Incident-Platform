import {
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import app from "../../src/app.js";

describe(
  "Security API",
  () => {

    it(
      "should include security headers",
      async () => {

        const response =
          await request(app)
            .get("/health/live");

        expect(
          response.headers[
            "x-content-type-options"
          ]
        ).toBe("nosniff");

        expect(
          response.headers[
            "x-frame-options"
          ]
        ).toBeDefined();

        expect(
          response.headers[
            "referrer-policy"
          ]
        ).toBeDefined();
      }
    );

    it(
      "should reject an oversized JSON body",
      async () => {

        const largeService =
          "a".repeat(101);

        const response =
          await request(app)
            .post("/incidents")
            .send({
              service:
                largeService,
              severity:
                "critical"
            });

        expect(response.status)
          .toBe(400);

        expect(response.body)
          .toEqual({
            success: false,
            error: {
              code:
                "SERVICE_TOO_LONG",
              message:
                "Service must not exceed 100 characters"
            }
          });
      }
    );

    it(
      "should reject an invalid severity",
      async () => {

        const response =
          await request(app)
            .post("/incidents")
            .send({
              service:
                "payment-service",
              severity:
                "extreme"
            });

        expect(response.status)
          .toBe(400);

        expect(response.body)
          .toEqual({
            success: false,
            error: {
              code:
                "INVALID_SEVERITY",
              message:
                "Invalid severity"
            }
          });
      }
    );

    it(
  "should reject a request body larger than the configured limit",
  async () => {

    const largeValue =
      "x".repeat(
        110 * 1024
      );

    const response =
      await request(app)
        .post("/incidents")
        .send({
          service:
            "payment-service",
          severity:
            "critical",
          extraData:
            largeValue
        });

    expect(response.status)
      .toBe(413);

    expect(response.body)
      .toEqual({
        success: false,
        error: {
          code:
            "PAYLOAD_TOO_LARGE",
          message:
            "Request payload is too large"
        }
      });
  }
);

it(
  "should reject malformed JSON safely",
  async () => {

    const response =
      await request(app)
        .post("/incidents")
        .set(
          "Content-Type",
          "application/json"
        )
        .send(
          '{"service":"payment-service"'
        );

    expect(response.status)
      .toBe(400);

    expect(response.body)
      .toEqual({
        success: false,
        error: {
          code:
            "INVALID_JSON",
          message:
            "Invalid JSON payload"
        }
      });
  }
);

//     it(
//   "should reject a request body larger than the configured limit",
//   async () => {

//     const largeValue =
//       "x".repeat(
//         110 * 1024
//       );

//     const response =
//       await request(app)
//         .post("/incidents")
//         .send({
//           service:
//             "payment-service",
//           severity:
//             "critical",
//           extraData:
//             largeValue
//         });

//     expect(response.status)
//       .toBe(413);
//   }
// );

    it(
      "should not expose internal details for unknown routes",
      async () => {

        const response =
          await request(app)
            .get(
              "/this-route-does-not-exist"
            );

        expect(response.status)
          .toBe(404);

        expect(
          response.body.error.message
        ).not.toContain(
          "Error:"
        );

        expect(
          response.body.error.message
        ).not.toContain(
          "node_modules"
        );

        expect(
          response.body.error.message
        ).not.toContain(
          "src/"
        );
      }
    );
  }
);