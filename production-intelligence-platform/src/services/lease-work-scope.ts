export type LeaseWorkState =
  | "active"
  | "aborted";

export class LeaseWorkScope {
  private readonly controller = new AbortController();

  private state: LeaseWorkState = "active";

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  getState(): LeaseWorkState {
    return this.state;
  }

  canStartWork(): boolean {
    return this.state === "active";
  }

  loseLease(reason?: unknown): void {
    if (this.state === "aborted") {
      return;
    }

    this.state = "aborted";

    this.controller.abort(
      reason ??
        new Error("Leadership lease was lost")
    );
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) {
      return;
    }

    throw this.signal.reason ??
      new Error("Work scope has been aborted");
  }
}