import {
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import app from "../../src/app.js";

describe(
  "Health API",
  () => {

    it(
      "should return 200 for liveness",
      async () => {

        const response =
          await request(app)
            .get("/health/live");

        expect(response.status)
          .toBe(200);

        expect(response.body.status)
          .toBe("ok");

        expect(response.body.state)
          .toBeDefined();
      }
    );

    it(
      "should return 200 for readiness when PostgreSQL is available",
      async () => {

        const response =
          await request(app)
            .get("/health/ready");

        expect(response.status)
          .toBe(200);

        expect(response.body)
          .toEqual({
            status: "ready",
            state: "ready",
            dependencies: {
              postgres: "connected"
            }
          });
      }
    );

    it(
      "should return the existing health response",
      async () => {

        const response =
          await request(app)
            .get("/health");

        expect(response.status)
          .toBe(200);

        expect(response.body.status)
          .toBe("ok");

        expect(
          response.body.service
        ).toBe(
          "production-intelligence-platform"
        );

        expect(
          response.body.database
        ).toBe("connected");
      }
    );
  }
);

