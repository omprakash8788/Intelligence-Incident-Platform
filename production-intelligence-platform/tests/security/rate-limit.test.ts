import {
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import express from "express";

import {
  createRateLimiter
} from "../../src/config/rate-limit.js";

describe(
  "rate limiting",
  () => {

    const createTestApp =
      () => {

        const app =
          express();

        app.use(
          express.json()
        );

        app.use(
          createRateLimiter({
            windowMs:
              60 * 1000,

            limit: 2
          })
        );

        app.get(
          "/test",
          (_req, res) => {
            res.status(200).json({
              success: true
            });
          }
        );

        return app;
      };

    it(
      "should allow requests within the limit",
      async () => {

        const app =
          createTestApp();

        const first =
          await request(app)
            .get("/test");

        const second =
          await request(app)
            .get("/test");

        expect(first.status)
          .toBe(200);

        expect(second.status)
          .toBe(200);
      }
    );

    it(
      "should reject requests after the limit",
      async () => {

        const app =
          createTestApp();

        await request(app)
          .get("/test");

        await request(app)
          .get("/test");

        const third =
          await request(app)
            .get("/test");

        expect(third.status)
          .toBe(429);

        expect(third.body)
          .toEqual({
            success: false,
            error: {
              code:
                "RATE_LIMIT_EXCEEDED",
              message:
                "Too many requests"
            }
          });
      }
    );
  }
);

