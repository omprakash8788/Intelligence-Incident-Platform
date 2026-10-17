export interface RedlockQuorumInput {
  nodeCount: number;
  acquiredCount: number;
  ttlMs: number;
  elapsedMs: number;
  driftFactor: number;
}

export interface RedlockQuorumResult {
  quorum: number;
  hasQuorum: boolean;
  driftAllowanceMs: number;
  validityMs: number;
  canUseLock: boolean;
}

export function evaluateRedlockQuorum(
  input: RedlockQuorumInput
): RedlockQuorumResult {
  const {
    nodeCount,
    acquiredCount,
    ttlMs,
    elapsedMs,
    driftFactor
  } = input;

  if (
    !Number.isSafeInteger(nodeCount) ||
    nodeCount < 1
  ) {
    throw new Error(
      "nodeCount must be a positive integer"
    );
  }

  if (
    !Number.isSafeInteger(acquiredCount) ||
    acquiredCount < 0 ||
    acquiredCount > nodeCount
  ) {
    throw new Error(
      "acquiredCount must be between zero and nodeCount"
    );
  }

  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new Error(
      "ttlMs must be a positive integer"
    );
  }

  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  ) {
    throw new Error(
      "elapsedMs must be a non-negative number"
    );
  }

  if (
    !Number.isFinite(driftFactor) ||
    driftFactor < 0 ||
    driftFactor >= 1
  ) {
    throw new Error(
      "driftFactor must be in the range [0, 1)"
    );
  }

  const quorum = Math.floor(nodeCount / 2) + 1;

  const hasQuorum = acquiredCount >= quorum;

  const driftAllowanceMs =
    ttlMs * driftFactor + 2;

  const validityMs =
    ttlMs - elapsedMs - driftAllowanceMs;

  return {
    quorum,
    hasQuorum,
    driftAllowanceMs,
    validityMs,
    canUseLock: hasQuorum && validityMs > 0
  };
}