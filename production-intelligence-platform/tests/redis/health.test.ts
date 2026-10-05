import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";

import {
  connectRedis,
  closeRedis
} from "../../src/redis/lifecycle.js";

import {
  checkRedisHealth
} from "../../src/redis/health.js";

describe(
  "Redis health",
  () => {
    beforeAll(
      async () => {
        await connectRedis();
      }
    );

    afterAll(
      async () => {
        await closeRedis();
      }
    );

    it(
      "returns true when Redis responds to PING",
      async () => {
        const healthy =
          await checkRedisHealth();

        expect(
          healthy
        ).toBe(true);
      }
    );
  }
);