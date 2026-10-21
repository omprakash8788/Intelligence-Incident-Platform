import { describe, expect, it, vi } from "vitest";

import {
  RetryExhaustedError,
  retryOperation
} from "../src/services/retry-operation.js";

describe("retryOperation", () => {
  it("succeeds on the first attempt", async () => {
    const operation = vi.fn(async () => "success");
    const wait = vi.fn(async () => undefined);

    const result = await retryOperation(operation, {
      maxAttempts: 3,
      delayMs: 100,
      shouldRetry: () => true,
      wait
    });

    expect(result).toEqual({
      value: "success",
      attempts: 1
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries transient failures and then succeeds", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("success");

    const wait = vi.fn(async () => undefined);

    const result = await retryOperation(operation, {
      maxAttempts: 3,
      delayMs: 50,
      shouldRetry: () => true,
      wait
    });

    expect(result).toEqual({
      value: "success",
      attempts: 3
    });

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 50);
    expect(wait).toHaveBeenNthCalledWith(2, 50);
  });

  it("stops when the retry limit is reached", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("service unavailable"));

    const wait = vi.fn(async () => undefined);

    let caughtError: unknown;

    try {
      await retryOperation(operation, {
        maxAttempts: 3,
        delayMs: 25,
        shouldRetry: () => true,
        wait
      });
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(RetryExhaustedError);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);

    expect(
      (caughtError as RetryExhaustedError).attempts
    ).toBe(3);

    expect(
      (caughtError as RetryExhaustedError).originalError
    ).toEqual(new Error("service unavailable"));
  });

  it("does not retry a non-retryable error", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("invalid request"));

    const wait = vi.fn(async () => undefined);

    await expect(
      retryOperation(operation, {
        maxAttempts: 5,
        delayMs: 100,
        shouldRetry: () => false,
        wait
      })
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects an invalid attempt limit", async () => {
    await expect(
      retryOperation(async () => "success", {
        maxAttempts: 0,
        delayMs: 100,
        shouldRetry: () => true
      })
    ).rejects.toThrow(
      "maxAttempts must be a positive integer"
    );
  });

  it("rejects a negative delay", async () => {
    await expect(
      retryOperation(async () => "success", {
        maxAttempts: 3,
        delayMs: -1,
        shouldRetry: () => true
      })
    ).rejects.toThrow(
      "delayMs must be a non-negative number"
    );
  });
});