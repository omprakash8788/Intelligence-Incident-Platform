import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";

import {
  workerPerformanceMetrics
} from "../src/services/worker-performance-metrics.service.js";

describe("worker performance metrics", () => {
  afterEach(() => {
    workerPerformanceMetrics.resetForTests();
  });

  it("starts with zero counters", () => {
    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(metrics.startedTotal).toBe(0);
    expect(metrics.completedTotal).toBe(0);
    expect(metrics.failedTotal).toBe(0);
    expect(metrics.retryAttemptsTotal).toBe(0);
    expect(metrics.activeJobs).toBe(0);
    expect(metrics.averageDurationMs).toBe(0);
    expect(metrics.throughputJobsPerSecond).toBe(0);
  });

  it("tracks started and completed jobs", () => {
    workerPerformanceMetrics.jobStarted("job-1");
    workerPerformanceMetrics.jobCompleted("job-1");

    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(metrics.startedTotal).toBe(1);
    expect(metrics.completedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.averageDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks failed jobs", () => {
    workerPerformanceMetrics.jobStarted("job-2");
    workerPerformanceMetrics.jobFailed("job-2");

    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(metrics.failedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
  });

  it("tracks retry attempts", () => {
    workerPerformanceMetrics.jobRetried();
    workerPerformanceMetrics.jobRetried();

    expect(
      workerPerformanceMetrics.snapshot().retryAttemptsTotal
    ).toBe(2);
  });

  it("includes a valid timestamp", () => {
    const metrics =
      workerPerformanceMetrics.snapshot();

    expect(
      Number.isNaN(Date.parse(metrics.sampledAt))
    ).toBe(false);
  });
});