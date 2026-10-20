export interface LeaseTimingConfig {
  leaseDurationMs: number;
  renewalIntervalMs: number;
  requestTimeoutMs: number;
  safetyMarginMs: number;
}

export interface LeaseTimingBudget {
  leaseDurationMs: number;
  renewalIntervalMs: number;
  requestTimeoutMs: number;
  safetyMarginMs: number;
  renewalBudgetMs: number;
  latestSafeRenewalStartMs: number;
  isValid: true;
}

function assertPositiveInteger(
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive safe integer`
    );
  }
}

function assertNonNegativeInteger(
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative safe integer`
    );
  }
}

export function evaluateLeaseTiming(
  config: LeaseTimingConfig
): LeaseTimingBudget {
  const {
    leaseDurationMs,
    renewalIntervalMs,
    requestTimeoutMs,
    safetyMarginMs
  } = config;

  assertPositiveInteger(
    "leaseDurationMs",
    leaseDurationMs
  );

  assertPositiveInteger(
    "renewalIntervalMs",
    renewalIntervalMs
  );

  assertPositiveInteger(
    "requestTimeoutMs",
    requestTimeoutMs
  );

  assertNonNegativeInteger(
    "safetyMarginMs",
    safetyMarginMs
  );

  const renewalBudgetMs =
    requestTimeoutMs + safetyMarginMs;

  const latestSafeRenewalStartMs =
    leaseDurationMs - renewalBudgetMs;

  if (latestSafeRenewalStartMs <= 0) {
    throw new Error(
      "Request timeout and safety margin must be " +
      "smaller than the lease duration"
    );
  }

  if (
    renewalIntervalMs >=
    latestSafeRenewalStartMs
  ) {
    throw new Error(
      "Renewal interval leaves insufficient time " +
      "for the request timeout and safety margin"
    );
  }

  return {
    leaseDurationMs,
    renewalIntervalMs,
    requestTimeoutMs,
    safetyMarginMs,
    renewalBudgetMs,
    latestSafeRenewalStartMs,
    isValid: true
  };
}