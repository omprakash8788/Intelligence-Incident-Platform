import {
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

import {
  httpMetrics
} from "../src/services/http-metrics.service.js";

describe("httpMetrics", () => {
  beforeEach(() => {
    httpMetrics.resetForTests();
  });

  it("starts with zero counters", () => {
    const metrics = httpMetrics.snapshot();

    expect(metrics.http_requests_total).toBe(0);
    expect(metrics.http_errors_5xx_total).toBe(0);
    expect(metrics.http_requests_active).toBe(0);
    expect(
      metrics.http_request_duration_ms_count
    ).toBe(0);
    expect(
      metrics.http_request_duration_ms_sum
    ).toBe(0);
    expect(
      metrics.http_request_duration_ms_avg
    ).toBe(0);
  });

  it("tracks active requests", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestStarted();

    expect(
      httpMetrics.snapshot().http_requests_active
    ).toBe(2);

    httpMetrics.requestFinished(200, 20);

    expect(
      httpMetrics.snapshot().http_requests_active
    ).toBe(1);
  });

  it("counts completed requests", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 25);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(404, 10);

    expect(
      httpMetrics.snapshot().http_requests_total
    ).toBe(2);
  });

  it("counts only HTTP 5xx responses as server errors", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 10);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(404, 10);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(503, 30);

    expect(
      httpMetrics.snapshot().http_errors_5xx_total
    ).toBe(1);
  });

  it("calculates average request duration", () => {
    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 20);

    httpMetrics.requestStarted();
    httpMetrics.requestFinished(200, 40);

    const metrics = httpMetrics.snapshot();

    expect(
      metrics.http_request_duration_ms_count
    ).toBe(2);

    expect(
      metrics.http_request_duration_ms_sum
    ).toBe(60);

    expect(
      metrics.http_request_duration_ms_avg
    ).toBe(30);
  });

  it("returns an ISO timestamp", () => {
    const metrics = httpMetrics.snapshot();

    expect(
      Number.isNaN(Date.parse(metrics.sampled_at))
    ).toBe(false);
  });
});