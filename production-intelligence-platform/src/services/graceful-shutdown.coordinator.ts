export type ShutdownStatus =
  | "completed"
  | "timed-out"
  | "failed";

export interface ShutdownResult {
  status: ShutdownStatus;
  errors: unknown[];
}

export interface GracefulShutdownDependencies {
  stopAcceptingWork(): Promise<void>;
  cancelActiveWork(): Promise<void>;
  waitForActiveWork(): Promise<void>;
  closeResources(): Promise<void>;
}

export interface GracefulShutdownConfig {
  drainTimeoutMs: number;
}

export class GracefulShutdownCoordinator {
  private shutdownPromise:
    Promise<ShutdownResult> | null = null;

  constructor(
    private readonly dependencies:
      GracefulShutdownDependencies,
    private readonly config:
      GracefulShutdownConfig
  ) {
    if (
      !Number.isSafeInteger(config.drainTimeoutMs) ||
      config.drainTimeoutMs < 1
    ) {
      throw new Error(
        "drainTimeoutMs must be a positive safe integer"
      );
    }
  }

  shutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.runShutdown();

    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<ShutdownResult> {
    const errors: unknown[] = [];

    let status: ShutdownStatus = "completed";

    try {
      await this.dependencies.stopAcceptingWork();
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    try {
      await this.dependencies.cancelActiveWork();
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    try {
      const drained = await this.waitForDrain();

      if (!drained && status !== "failed") {
        status = "timed-out";
      }
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    try {
      await this.dependencies.closeResources();
    } catch (error) {
      errors.push(error);
      status = "failed";
    }

    return {
      status,
      errors
    };
  }

  private async waitForDrain(): Promise<boolean> {
    let timeoutId:
      ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(
        () => resolve(false),
        this.config.drainTimeoutMs
      );
    });

    try {
      return await Promise.race([
        this.dependencies
          .waitForActiveWork()
          .then(() => true),
        timeout
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}