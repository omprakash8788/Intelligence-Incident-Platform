export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  shouldRetry: (error: unknown) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
}

export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly originalError: unknown;

  constructor(attempts: number, originalError: unknown) {
    super(`Operation failed after ${attempts} attempts`);

    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.originalError = originalError;
  }
}

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    delayMs,
    shouldRetry,
    wait = defaultWait
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a non-negative number");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await operation(attempt);

      return {
        value,
        attempts: attempt
      };
    } catch (error: unknown) {
      lastError = error;

      const attemptsRemain = attempt < maxAttempts;

      if (!attemptsRemain || !shouldRetry(error)) {
        break;
      }

      await wait(delayMs);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}