import {
  describe,
  expect,
  it
} from "vitest";

import {
  evaluateRedlockQuorum
} from "../src/services/redlock-quorum.policy.js";

describe("evaluateRedlockQuorum", () => {
  it("requires three nodes out of five", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 3,
      ttlMs: 10_000,
      elapsedMs: 200,
      driftFactor: 0.01
    });

    expect(result.quorum).toBe(3);
    expect(result.hasQuorum).toBe(true);
    expect(result.canUseLock).toBe(true);
  });

  it("rejects a minority of acquired locks", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 2,
      ttlMs: 10_000,
      elapsedMs: 200,
      driftFactor: 0.01
    });

    expect(result.quorum).toBe(3);
    expect(result.hasQuorum).toBe(false);
    expect(result.canUseLock).toBe(false);
  });

  it("rejects a lock with no remaining validity", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 5,
      ttlMs: 1_000,
      elapsedMs: 1_100,
      driftFactor: 0.01
    });

    expect(result.hasQuorum).toBe(true);
    expect(result.validityMs).toBeLessThanOrEqual(0);
    expect(result.canUseLock).toBe(false);
  });

  it("calculates the validity window", () => {
    const result = evaluateRedlockQuorum({
      nodeCount: 5,
      acquiredCount: 3,
      ttlMs: 10_000,
      elapsedMs: 200,
      driftFactor: 0.01
    });

    expect(result.driftAllowanceMs).toBe(102);
    expect(result.validityMs).toBe(9_698);
  });

  it("rejects invalid node counts", () => {
    expect(() =>
      evaluateRedlockQuorum({
        nodeCount: 0,
        acquiredCount: 0,
        ttlMs: 10_000,
        elapsedMs: 0,
        driftFactor: 0.01
      })
    ).toThrow("nodeCount must be a positive integer");
  });

  it("rejects more acquired nodes than available nodes", () => {
    expect(() =>
      evaluateRedlockQuorum({
        nodeCount: 3,
        acquiredCount: 4,
        ttlMs: 10_000,
        elapsedMs: 0,
        driftFactor: 0.01
      })
    ).toThrow(
      "acquiredCount must be between zero and nodeCount"
    );
  });

  it("rejects an invalid drift factor", () => {
    expect(() =>
      evaluateRedlockQuorum({
        nodeCount: 5,
        acquiredCount: 3,
        ttlMs: 10_000,
        elapsedMs: 0,
        driftFactor: 1
      })
    ).toThrow(
      "driftFactor must be in the range [0, 1)"
    );
  });
});