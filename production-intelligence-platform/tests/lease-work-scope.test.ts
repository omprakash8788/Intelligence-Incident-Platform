import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  LeaseWorkScope
} from "../src/services/lease-work-scope.js";

describe("LeaseWorkScope", () => {
  it("starts in the active state", () => {
    const scope = new LeaseWorkScope();

    expect(scope.getState()).toBe("active");
    expect(scope.canStartWork()).toBe(true);
    expect(scope.signal.aborted).toBe(false);
  });

  it("aborts when the lease is lost", () => {
    const scope = new LeaseWorkScope();

    scope.loseLease();

    expect(scope.getState()).toBe("aborted");
    expect(scope.canStartWork()).toBe(false);
    expect(scope.signal.aborted).toBe(true);
  });

  it("notifies listeners when the lease is lost", () => {
    const scope = new LeaseWorkScope();
    const listener = vi.fn();

    scope.signal.addEventListener(
      "abort",
      listener
    );

    scope.loseLease();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not abort twice", () => {
    const scope = new LeaseWorkScope();
    const listener = vi.fn();

    scope.signal.addEventListener(
      "abort",
      listener
    );

    scope.loseLease();
    scope.loseLease();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(scope.getState()).toBe("aborted");
  });

  it("throws when work checks an aborted scope", () => {
    const scope = new LeaseWorkScope();

    scope.loseLease();

    expect(() => {
      scope.throwIfAborted();
    }).toThrow("Leadership lease was lost");
  });

  it("stops an in-flight cooperative task after lease loss", async () => {
  const scope = new LeaseWorkScope();

  let markStarted!: () => void;

  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const steps: string[] = [];

  const task = async (): Promise<void> => {
    steps.push("started");
    markStarted();

    // Simulate an asynchronous operation already in progress.
    await new Promise<void>((resolve) => {
      scope.signal.addEventListener(
        "abort",
        () => resolve(),
        { once: true }
      );
    });

    // The task must check cancellation before continuing.
    scope.throwIfAborted();

    steps.push("write");
  };

  const taskPromise = task();

  await started;

  expect(steps).toEqual(["started"]);

  scope.loseLease();

  await expect(taskPromise).rejects.toThrow(
    "Leadership lease was lost"
  );

  expect(steps).toEqual(["started"]);
});

  it("does not throw while the scope is active", () => {
    const scope = new LeaseWorkScope();

    expect(() => {
      scope.throwIfAborted();
    }).not.toThrow();
  });

  it("allows cooperative work to stop after lease loss", async () => {
    const scope = new LeaseWorkScope();

    const steps: string[] = [];

    const task = async (): Promise<void> => {
      scope.throwIfAborted();
      steps.push("download");

      scope.throwIfAborted();
      steps.push("transform");

      scope.throwIfAborted();
      steps.push("write");
    };

    scope.loseLease();

    await expect(task()).rejects.toThrow(
      "Leadership lease was lost"
    );

    expect(steps).toEqual([]);
  });

  it("does not reactivate after lease loss", () => {
    const scope = new LeaseWorkScope();

    scope.loseLease();

    expect(scope.canStartWork()).toBe(false);
    expect(scope.getState()).toBe("aborted");
  });
});