import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";

import {
  workerMetrics
} from "../src/services/worker-metrics.service.js";

describe("worker metrics service", () => {
  afterEach(() => {
    workerMetrics.resetForTests();
  });

  it("starts with zero counters", () => {
    const metrics = workerMetrics.snapshot();

    expect(metrics.startedTotal).toBe(0);
    expect(metrics.completedTotal).toBe(0);
    expect(metrics.failedTotal).toBe(0);
    expect(metrics.activeJobs).toBe(0);
  });

  it("tracks active jobs", () => {
    workerMetrics.jobStarted();
    workerMetrics.jobStarted();

    expect(
      workerMetrics.snapshot().activeJobs
    ).toBe(2);
  });

  it("tracks completed jobs", () => {
    workerMetrics.jobStarted();
    workerMetrics.jobCompleted();

    const metrics = workerMetrics.snapshot();

    expect(metrics.startedTotal).toBe(1);
    expect(metrics.completedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
  });

  it("tracks failed jobs", () => {
    workerMetrics.jobStarted();
    workerMetrics.jobFailed();

    const metrics = workerMetrics.snapshot();

    expect(metrics.failedTotal).toBe(1);
    expect(metrics.activeJobs).toBe(0);
  });

  it("includes a timestamp", () => {
    const metrics = workerMetrics.snapshot();

    expect(
      Number.isNaN(
        Date.parse(metrics.sampledAt)
      )
    ).toBe(false);
  });
});