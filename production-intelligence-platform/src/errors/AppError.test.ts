import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/AppError.js";

describe("AppError", () => {
  it("should create a structured application error", () => {
    const error = new AppError(
      "Something went wrong",
      400,
      "TEST_ERROR"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);

    expect(error.message).toBe("Something went wrong");
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("TEST_ERROR");
  });
});