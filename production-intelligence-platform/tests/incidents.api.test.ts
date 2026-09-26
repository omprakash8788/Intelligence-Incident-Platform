// import { describe, expect, it } from "vitest";
// import request from "supertest";
// import app from "../src/app.js";

// describe("POST /incidents", () => {
//   it("should create an incident request", async () => {
//     const response = await request(app)
//       .post("/incidents")
//       .send({
//         service: "payment-service",
//         severity: "critical"
//       });

//     expect(response.status).toBe(201);

//     expect(response.body).toEqual({
//       success: true,
//       data: {
//         service: "payment-service",
//         severity: "critical"
//       }
//     });
//   });

//   it("should reject missing service", async () => {
//     const response = await request(app)
//       .post("/incidents")
//       .send({
//         severity: "critical"
//       });

//     expect(response.status).toBe(400);

//     expect(response.body).toEqual({
//       success: false,
//       error: {
//         code: "SERVICE_REQUIRED",
//         message: "Service is required"
//       }
//     });
//   });

//   it("should reject invalid severity", async () => {
//     const response = await request(app)
//       .post("/incidents")
//       .send({
//         service: "payment-service",
//         severity: "banana"
//       });

//     expect(response.status).toBe(400);

//     expect(response.body).toEqual({
//       success: false,
//       error: {
//         code: "INVALID_SEVERITY",
//         message: "Invalid severity"
//       }
//     });
//   });
// });

import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/app.js";

describe("Incident API", () => {
  it("should create an incident", async () => {
    const response = await request(app)
      .post("/incidents")
      .send({
        service: "payment-service",
        severity: "critical"
      });

    expect(response.status).toBe(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.service)
      .toBe("payment-service");

    expect(response.body.data.severity)
      .toBe("critical");

    expect(response.body.data.status)
      .toBe("detected");

    expect(response.body.data.id)
      .toBeDefined();
  });

  it("should list incidents", async () => {

    const response =
      await request(app)
        .get("/incidents")
        .query({
          page: 1,
          limit: 5
        });

    expect(response.status)
      .toBe(200);

    expect(response.body.success)
      .toBe(true);

    expect(
      Array.isArray(response.body.data)
    ).toBe(true);

    expect(response.body.meta)
      .toEqual(
        expect.objectContaining({
          page: 1,
          limit: 5
        })
      );
  });


  it("should filter incidents by service", async () => {

    const response =
      await request(app)
        .get("/incidents")
        .query({
          service: "payment-service",
          limit: 10
        });

    expect(response.status)
      .toBe(200);

    expect(response.body.success)
      .toBe(true);

    for (
      const incident
      of response.body.data
    ) {
      expect(incident.service)
        .toBe("payment-service");
    }
  });


  it("should reject an invalid severity", async () => {

    const response =
      await request(app)
        .get("/incidents")
        .query({
          severity: "banana"
        });

    expect(response.status)
      .toBe(400);

    expect(response.body)
      .toEqual({
        success: false,
        error: {
          code: "INVALID_SEVERITY",
          message: "Invalid severity"
        }
      });
  });

  it("should reject an invalid limit", async () => {

    const response =
      await request(app)
        .get("/incidents")
        .query({
          limit: 101
        });

    expect(response.status)
      .toBe(400);

    expect(response.body)
      .toEqual({
        success: false,
        error: {
          code: "INVALID_LIMIT",
          message:
            "limit must be between 1 and 100"
        }
      });
  });

  it("should return 404 for missing incident", async () => {
    const response = await request(app)
      .get(
        "/incidents/00000000-0000-0000-0000-000000000000"
      );

    expect(response.status).toBe(404);

    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INCIDENT_NOT_FOUND",
        message: "Incident not found"
      }
    });
  });
});