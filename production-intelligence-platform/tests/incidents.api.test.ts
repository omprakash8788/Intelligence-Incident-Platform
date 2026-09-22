import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("POST /incidents", () => {
  it("should create an incident request", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        service: "payment-service",
        severity: "critical"
      });

    expect(response.status).toBe(201);

    expect(response.body).toEqual({
      success: true,
      data: {
        service: "payment-service",
        severity: "critical"
      }
    });
  });

  it("should reject missing service", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        severity: "critical"
      });

    expect(response.status).toBe(400);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "SERVICE_REQUIRED",
        message: "Service is required"
      }
    });
  });

  it("should reject invalid severity", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        service: "payment-service",
        severity: "banana"
      });

    expect(response.status).toBe(400);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INVALID_SEVERITY",
        message: "Invalid severity"
      }
    });
  });
});