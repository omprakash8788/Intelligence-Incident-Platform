export interface HttpMetricsSnapshot {
  http_requests_total: number;
  http_errors_5xx_total: number;
  http_requests_active: number;
  http_request_duration_ms_count: number;
  http_request_duration_ms_sum: number;
  http_request_duration_ms_avg: number;
  sampled_at: string;
}

interface HttpMetricsState {
  requestsTotal: number;
  errors5xxTotal: number;
  activeRequests: number;
  durationCount: number;
  durationSumMs: number;
}

const createInitialState = (): HttpMetricsState => ({
  requestsTotal: 0,
  errors5xxTotal: 0,
  activeRequests: 0,
  durationCount: 0,
  durationSumMs: 0
});

let state = createInitialState();

export const httpMetrics = {
  requestStarted(): void {
    state.activeRequests += 1;
  },

  requestFinished(
    statusCode: number,
    durationMs: number
  ): void {
    state.requestsTotal += 1;

    if (
      Number.isInteger(statusCode) &&
      statusCode >= 500 &&
      statusCode <= 599
    ) {
      state.errors5xxTotal += 1;
    }

    state.activeRequests = Math.max(
      0,
      state.activeRequests - 1
    );

    const safeDurationMs =
      Number.isFinite(durationMs)
        ? Math.max(0, durationMs)
        : 0;

    state.durationCount += 1;
    state.durationSumMs += safeDurationMs;
  },

  snapshot(): HttpMetricsSnapshot {
    const averageDuration =
      state.durationCount === 0
        ? 0
        : state.durationSumMs /
          state.durationCount;

    return {
      http_requests_total:
        state.requestsTotal,

      http_errors_5xx_total:
        state.errors5xxTotal,

      http_requests_active:
        state.activeRequests,

      http_request_duration_ms_count:
        state.durationCount,

      http_request_duration_ms_sum:
        state.durationSumMs,

      http_request_duration_ms_avg:
        averageDuration,

      sampled_at: new Date().toISOString()
    };
  },

  resetForTests(): void {
    state = createInitialState();
  }
};