export interface WorkerMetricsSnapshot {
  worker: string;
  startedTotal: number;
  completedTotal: number;
  failedTotal: number;
  activeJobs: number;
  sampledAt: string;
}

class WorkerMetricsService {
  private startedTotal = 0;
  private completedTotal = 0;
  private failedTotal = 0;
  private activeJobs = 0;

  jobStarted(): void {
    this.startedTotal += 1;
    this.activeJobs += 1;
  }

  jobCompleted(): void {
    this.completedTotal += 1;
    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );
  }

  jobFailed(): void {
    this.failedTotal += 1;
    this.activeJobs = Math.max(
      0,
      this.activeJobs - 1
    );
  }

  snapshot(): WorkerMetricsSnapshot {
    return {
      worker: "external-api",
      startedTotal: this.startedTotal,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
      activeJobs: this.activeJobs,
      sampledAt: new Date().toISOString()
    };
  }

  resetForTests(): void {
    this.startedTotal = 0;
    this.completedTotal = 0;
    this.failedTotal = 0;
    this.activeJobs = 0;
  }
}

export const workerMetrics =
  new WorkerMetricsService();