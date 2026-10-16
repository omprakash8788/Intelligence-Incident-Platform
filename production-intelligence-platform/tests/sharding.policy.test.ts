import {
  describe,
  expect,
  it
} from "vitest";

import {
  resolveShardIndex
} from "../src/services/sharding.policy.js";

import {
  SHARD_COUNT
} from "../src/queues/sharding.config.js";

describe("resolveShardIndex", () => {
  it("returns the same shard for the same key", () => {
    const first = resolveShardIndex(
      "payment-service"
    );

    const second = resolveShardIndex(
      "payment-service"
    );

    expect(first).toBe(second);
  });

  it("normalizes surrounding whitespace", () => {
    expect(
      resolveShardIndex(" payment-service ")
    ).toBe(
      resolveShardIndex("payment-service")
    );
  });

  it("returns a valid shard index", () => {
    const keys = [
      "payment-service",
      "authentication-service",
      "notification-service",
      "inventory-service",
      "billing-service"
    ];

    for (const key of keys) {
      const shardIndex = resolveShardIndex(key);

      expect(shardIndex).toBeGreaterThanOrEqual(0);
      expect(shardIndex).toBeLessThan(SHARD_COUNT);
      expect(Number.isInteger(shardIndex)).toBe(true);
    }
  });

  it("rejects an empty partition key", () => {
    expect(() => {
      resolveShardIndex("");
    }).toThrow(TypeError);
  });

  it("rejects a whitespace-only partition key", () => {
    expect(() => {
      resolveShardIndex("   ");
    }).toThrow(TypeError);
  });

  it("rejects a zero shard count", () => {
    expect(() => {
      resolveShardIndex("payment-service", 0);
    }).toThrow(RangeError);
  });

  it("rejects a non-integer shard count", () => {
    expect(() => {
      resolveShardIndex("payment-service", 2.5);
    }).toThrow(RangeError);
  });
});