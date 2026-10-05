import {
  describe,
  expect,
  it
} from "vitest";

import { env } from "../../src/config/env.js";

describe(
  "environment configuration",
  () => {

    it(
      "should expose a valid application configuration",
      () => {

        expect(
          env.app.nodeEnv
        ).toMatch(
          /^(development|test|production)$/
        );

        expect(
          env.app.port
        ).toBeGreaterThan(0);
      }
    );

    it(
  "loads Redis connection timeout",
  () => {
    expect(
      env.redis.connectTimeoutMs
    ).toBeGreaterThan(0);
  }
)

    it(
      "should expose a valid PostgreSQL configuration",
      () => {

        expect(
          env.postgres.host
        ).toBeTruthy();

        expect(
          env.postgres.port
        ).toBeGreaterThan(0);

        expect(
          env.postgres.database
        ).toBeTruthy();

        expect(
          env.postgres.user
        ).toBeTruthy();

        expect(
          env.postgres.password
        ).toBeTruthy();
      }
    );

    it(
      "should expose security configuration",
      () => {

        expect(
          env.security.requestBodyLimit
        ).toBe("100kb");
      }
    );
  }
);