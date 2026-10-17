import {
  describe,
  expect,
  it
} from "vitest";

import {
  recordIdempotentEffect
} from "../src/services/idempotent-effect.service.js";

describe("recordIdempotentEffect input validation", () => {
  it("rejects an empty idempotency key", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "   ",
        message: "Record incident"
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects an empty message", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "incident-123",
        message: "   "
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects an idempotency key over 200 characters", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "k".repeat(201),
        message: "Record incident"
      })
    ).rejects.toThrow(TypeError);
  });

  it("rejects a message over 500 characters", async () => {
    await expect(
      recordIdempotentEffect({
        idempotencyKey: "incident-123",
        message: "m".repeat(501)
      })
    ).rejects.toThrow(TypeError);
  });
});