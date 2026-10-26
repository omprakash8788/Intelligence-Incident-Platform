import { performance } from "node:perf_hooks";

export interface WorkerPerformanceSnapshot {
  worker: string;
  startedTotal: number;
  completedTotal: number;
  failedTotal: number;
  retryAttemptsTotal: number;
  activeJobs: number;
  totalDurationMs: number;
  averageDurationMs: number;
  completionsLastMinute: number;
  throughputJobsPerSecond: number;
  sampledAt: string;
}

interface CompletionSample {
  at: number;
  durationMs: number;
}

class WorkerPerformanceMetricsService {
  private startedTotal = 0;
  private completedTotal = 0;
  private failedTotal = 0;
  private retryAttemptsTotal = 0;
  private activeJobs = 0;
  private totalDurationMs = 0;

  private readonly startTimes = new Map<string, number>();
  private readonly completionSamples: CompletionSample[] = [];

  private readonly windowMs = 60_000;

  jobStarted(jobId: string): void {
    this.startedTotal += 1;
    this.activeJobs += 1;

    this.startTimes.set(
      jobId,
      performance.now()
    );
  }

  jobCompleted(jobId: string): void {
    const startTime = this.startTimes.get(jobId);

    if (startTime !== undefined) {
      const durationMs = Math.max(
        0,
        performance.now() - startTime
      );

      this.totalDurationMs += durationMs;

      this.completionSamples.push({
        at: Date.now(),
        durationMs
      });

      this.startTimes.delete(jobId);
    }

    this.completedTotal += 1;
    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );

    this.pruneCompletionSamples();
  }

  jobFailed(jobId: string): void {
    this.failedTotal += 1;
    this.startTimes.delete(jobId);

    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );

    this.pruneCompletionSamples();
  }

  jobRetried(): void {
    this.retryAttemptsTotal += 1;
  }

  snapshot(): WorkerPerformanceSnapshot {
    this.pruneCompletionSamples();

    const completionsLastMinute =
      this.completionSamples.length;

    const averageDurationMs =
      this.completedTotal === 0
        ? 0
        : this.totalDurationMs / this.completedTotal;

    return {
      worker: "external-api",
      startedTotal: this.startedTotal,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
      retryAttemptsTotal: this.retryAttemptsTotal,
      activeJobs: this.activeJobs,
      totalDurationMs: this.totalDurationMs,
      averageDurationMs,
      completionsLastMinute,
      throughputJobsPerSecond:
        completionsLastMinute / (this.windowMs / 1000),
      sampledAt: new Date().toISOString()
    };
  }

  resetForTests(): void {
    this.startedTotal = 0;
    this.completedTotal = 0;
    this.failedTotal = 0;
    this.retryAttemptsTotal = 0;
    this.activeJobs = 0;
    this.totalDurationMs = 0;
    this.startTimes.clear();
    this.completionSamples.length = 0;
  }

  private pruneCompletionSamples(): void {
    const cutoff = Date.now() - this.windowMs;

    while (
      this.completionSamples.length > 0 &&
      this.completionSamples[0]!.at < cutoff
    ) {
      this.completionSamples.shift();
    }
  }
}

export const workerPerformanceMetrics =
  new WorkerPerformanceMetricsService();