import {
  transitionLeaderRuntime,
  type LeaderRuntimeState
} from "./leader-runtime.policy.js";

export interface LeaseProvider<Lease> {
  acquire(): Promise<Lease | null>;
  renew(lease: Lease): Promise<Lease | null>;
  release(lease: Lease): Promise<boolean>;
}

export interface LeaderHooks {
  onLeadershipAcquired(): Promise<void>;
  onLeadershipLost(): Promise<void>;
}

export interface LeaderRuntimeConfig {
  retryIntervalMs: number;
}

export interface LeaderRuntimeDependencies<Lease> {
  leaseProvider: LeaseProvider<Lease>;
  hooks: LeaderHooks;
  config: LeaderRuntimeConfig;
  onError?: (error: unknown) => void;
}

function validateConfig(
  config: LeaderRuntimeConfig
): void {
  if (
    !Number.isSafeInteger(config.retryIntervalMs) ||
    config.retryIntervalMs <= 0
  ) {
    throw new Error(
      "retryIntervalMs must be a positive safe integer"
    );
  }
}

function sleep(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, {
      once: true
    });
  });
}

export class LeaderRuntime<Lease> {
  private state: LeaderRuntimeState = "stopped";
  private currentLease: Lease | null = null;
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private hooksStarted = false;

  constructor(
    private readonly dependencies:
      LeaderRuntimeDependencies<Lease>
  ) {
    validateConfig(dependencies.config);
  }

  getState(): LeaderRuntimeState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(
        `Cannot start leader runtime from state: ${this.state}`
      );
    }

    this.state = transitionLeaderRuntime(
      this.state,
      "START"
    );

    this.controller = new AbortController();

    this.loopPromise = this.runLoop(
      this.controller.signal
    );

    // Wait until the first acquisition attempt completes.
    // This makes the initial state observable to the caller.
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.performStop();

    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }

    if (this.state !== "stopping") {
      this.state = transitionLeaderRuntime(
        this.state,
        "STOP"
      );
    }

    this.controller?.abort();

    const loop = this.loopPromise;

    if (loop) {
      await loop;
    }

    // Release only after the renewal/acquisition loop has ended.
    const lease = this.currentLease;

    this.currentLease = null;

    if (lease !== null) {
      try {
        await this.dependencies.leaseProvider.release(
          lease
        );
      } catch (error) {
        this.reportError(error);
      }
    }

    if (this.hooksStarted) {
      this.hooksStarted = false;

      try {
        await this.dependencies.hooks
          .onLeadershipLost();
      } catch (error) {
        this.reportError(error);
      }
    }

    this.state = transitionLeaderRuntime(
      this.state,
      "STOP"
    );
  }

  private async runLoop(
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      if (this.currentLease === null) {
        await this.tryAcquire(signal);
      } else {
        await this.tryRenew(signal);
      }

      if (signal.aborted) {
        break;
      }

      await sleep(
        this.dependencies.config.retryIntervalMs,
        signal
      );
    }
  }

  private async tryAcquire(
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }

    try {
      const lease =
        await this.dependencies.leaseProvider.acquire();

      if (signal.aborted) {
        if (lease !== null) {
          try {
            await this.dependencies.leaseProvider
              .release(lease);
          } catch (error) {
            this.reportError(error);
          }
        }

        return;
      }

      if (lease === null) {
        this.state = transitionLeaderRuntime(
          this.state,
          "ACQUIRE_FAILED"
        );

        return;
      }

      this.currentLease = lease;

      this.state = transitionLeaderRuntime(
        this.state,
        "ACQUIRE_SUCCEEDED"
      );

      await this.dependencies.hooks
        .onLeadershipAcquired();

      this.hooksStarted = true;
    } catch (error) {
      this.reportError(error);

      if (this.state === "acquiring") {
        this.state = transitionLeaderRuntime(
          this.state,
          "ACQUIRE_FAILED"
        );
      } else if (this.state === "leader") {
        await this.loseLeadership();
      }
    }
  }

  private async tryRenew(
    signal: AbortSignal
  ): Promise<void> {
    const lease = this.currentLease;

    if (lease === null || signal.aborted) {
      return;
    }

    try {
      const renewedLease =
        await this.dependencies.leaseProvider
          .renew(lease);

      if (signal.aborted) {
        return;
      }

      if (renewedLease === null) {
        await this.loseLeadership();
        return;
      }

      this.currentLease = renewedLease;

      this.state = transitionLeaderRuntime(
        this.state,
        "RENEW_SUCCEEDED"
      );
    } catch (error) {
      this.reportError(error);
      await this.loseLeadership();
    }
  }

  private async loseLeadership(): Promise<void> {
    this.currentLease = null;

    if (this.state === "leader") {
      this.state = transitionLeaderRuntime(
        this.state,
        "RENEW_FAILED"
      );
    }

    if (this.hooksStarted) {
      this.hooksStarted = false;

      try {
        await this.dependencies.hooks
          .onLeadershipLost();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.dependencies.onError?.(error);
    } catch {
      // Error reporting must not crash the runtime loop.
    }
  }
}