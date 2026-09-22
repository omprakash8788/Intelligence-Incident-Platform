import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/errors/NotFoundError.js";

describe("NotFoundError", () => {
  it("should have status code 404", () => {
    const error = new NotFoundError(
      "Incident not found",
      "INCIDENT_NOT_FOUND"
    );

    expect(error.statusCode).toBe(404);

    expect(error.code).toBe("INCIDENT_NOT_FOUND");

    expect(error.message).toBe("Incident not found");
  });
});