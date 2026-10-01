import {
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import app from "../../src/app.js";

describe(
  "API rate limiting",
  () => {

    it(
      "should not apply the incident API limiter to health checks",
      async () => {

        const first =
          await request(app)
            .get("/health/live");

        const second =
          await request(app)
            .get("/health/live");

        expect(first.status)
          .toBe(200);

        expect(second.status)
          .toBe(200);
      }
    );

    it(
      "should expose rate limit headers for incident APIs",
      async () => {

        const response =
          await request(app)
            .get("/incidents");

        expect(response.status)
          .not.toBe(429);

        expect(
          response.headers[
            "ratelimit"
          ]
        ).toBeDefined();
      }
    );
  }
);