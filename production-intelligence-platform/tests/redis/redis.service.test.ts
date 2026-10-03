import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import {
  connectRedis,
  closeRedis
} from "../../src/redis/lifecycle.js";

import {
  redis
} from "../../src/redis/client.js";

import {
  RedisService
} from "../../src/services/redis.service.js";

const redisService =
  new RedisService();

describe(
  "RedisService",
  () => {
    beforeAll(
      async () => {
        await connectRedis();
      }
    );

    beforeEach(
      async () => {
        await redis.flushdb();
      }
    );

    afterAll(
      async () => {
        await closeRedis();
      }
    );

    it(
      "sets and gets a value",
      async () => {
        await redisService.set(
          "test:key",
          "hello"
        );

        const value =
          await redisService.get(
            "test:key"
          );

        expect(value).toBe(
          "hello"
        );
      }
    );

    it(
      "returns null for a missing key",
      async () => {
        const value =
          await redisService.get(
            "missing:key"
          );

        expect(value).toBeNull();
      }
    );

    it(
      "increments a counter",
      async () => {
        const first =
          await redisService.increment(
            "test:counter"
          );

        const second =
          await redisService.increment(
            "test:counter"
          );

        expect(first).toBe(1);
        expect(second).toBe(2);
      }
    );

    it(
      "sets a value with expiration",
      async () => {
        await redisService
          .setWithExpiration(
            "test:ttl",
            "temporary",
            30
          );

        const value =
          await redisService.get(
            "test:ttl"
          );

        const ttl =
          await redis.ttl(
            "test:ttl"
          );

        expect(value).toBe(
          "temporary"
        );

        expect(ttl).toBeGreaterThan(
          0
        );
      }
    );

    it(
      "deletes a key",
      async () => {
        await redisService.set(
          "test:delete",
          "value"
        );

        await redisService.delete(
          "test:delete"
        );

        const value =
          await redisService.get(
            "test:delete"
          );

        expect(value).toBeNull();
      }
    );
  }
);

