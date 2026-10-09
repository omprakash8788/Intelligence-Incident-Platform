export class RetryableJobError
  extends Error {

  public readonly retryable =
    true;

  constructor(
    message: string
  ) {
    super(message);

    this.name =
      "RetryableJobError";

    Object.setPrototypeOf(
      this,
      RetryableJobError.prototype
    );
  }
}

export class NonRetryableJobError
  extends Error {

  public readonly retryable =
    false;

  constructor(
    message: string
  ) {
    super(message);

    this.name =
      "NonRetryableJobError";

    Object.setPrototypeOf(
      this,
      NonRetryableJobError.prototype
    );
  }
}