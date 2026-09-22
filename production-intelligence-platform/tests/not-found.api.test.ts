import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("Unknown routes", () => {
  it("should return structured 404 error", async () => {
    const response = await request(app)
      .get("/does-not-exist");

    expect(response.status).toBe(404);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route GET /does-not-exist not found"
      }
    });
  });
});