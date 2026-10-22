import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";

import request from "supertest";

import app from "../src/app.js";

import {
  httpMetrics
} from "../src/services/http-metrics.service.js";

describe("GET /monitoring/metrics", () => {
  afterEach(() => {
    httpMetrics.resetForTests();
  });

  it("returns a metrics snapshot", async () => {
    const response = await request(app)
      .get("/monitoring/metrics");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    expect(
      response.body.data.http_requests_total
    ).toEqual(expect.any(Number));

    expect(
      response.body.data.http_errors_5xx_total
    ).toEqual(expect.any(Number));

    expect(
      response.body.data.http_requests_active
    ).toEqual(expect.any(Number));

    expect(
      response.body.data.http_request_duration_ms_avg
    ).toEqual(expect.any(Number));

    expect(
      Number.isNaN(
        Date.parse(response.body.data.sampled_at)
      )
    ).toBe(false);
  });
});