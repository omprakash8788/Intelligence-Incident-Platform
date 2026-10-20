import { describe, expect, it } from "vitest";

import {
  evaluateLeaseTiming,
  type LeaseTimingConfig
} from "../src/services/lease-timing.policy.js";

const validConfig: LeaseTimingConfig = {
  leaseDurationMs: 15_000,
  renewalIntervalMs: 5_000,
  requestTimeoutMs: 2_000,
  safetyMarginMs: 1_000
};

describe("evaluateLeaseTiming", () => {
  it("accepts a valid timing budget", () => {
    const result = evaluateLeaseTiming(validConfig);

    expect(result.isValid).toBe(true);
    expect(result.renewalBudgetMs).toBe(3_000);
    expect(result.latestSafeRenewalStartMs).toBe(
      12_000
    );
  });

  it("rejects a zero lease duration", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        leaseDurationMs: 0
      })
    ).toThrow(
      "leaseDurationMs must be a positive safe integer"
    );
  });

  it("rejects a negative renewal interval", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        renewalIntervalMs: -1
      })
    ).toThrow(
      "renewalIntervalMs must be a positive safe integer"
    );
  });

  it("rejects a non-integer request timeout", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        requestTimeoutMs: 1.5
      })
    ).toThrow(
      "requestTimeoutMs must be a positive safe integer"
    );
  });

  it("rejects a negative safety margin", () => {
    expect(() =>
      evaluateLeaseTiming({
        ...validConfig,
        safetyMarginMs: -1
      })
    ).toThrow(
      "safetyMarginMs must be a non-negative safe integer"
    );
  });

  it("rejects a timeout and margin that consume the lease", () => {
    expect(() =>
      evaluateLeaseTiming({
        leaseDurationMs: 3_000,
        renewalIntervalMs: 500,
        requestTimeoutMs: 2_000,
        safetyMarginMs: 1_000
      })
    ).toThrow(
      "Request timeout and safety margin must be " +
      "smaller than the lease duration"
    );
  });

  it("rejects a renewal interval that leaves insufficient time", () => {
    expect(() =>
      evaluateLeaseTiming({
        leaseDurationMs: 10_000,
        renewalIntervalMs: 7_000,
        requestTimeoutMs: 2_000,
        safetyMarginMs: 1_000
      })
    ).toThrow(
      "Renewal interval leaves insufficient time " +
      "for the request timeout and safety margin"
    );
  });

  it("accepts a zero safety margin but still checks the timeout", () => {
    const result = evaluateLeaseTiming({
      leaseDurationMs: 10_000,
      renewalIntervalMs: 5_000,
      requestTimeoutMs: 2_000,
      safetyMarginMs: 0
    });

    expect(result.renewalBudgetMs).toBe(2_000);
    expect(result.latestSafeRenewalStartMs).toBe(
      8_000
    );
  });
});