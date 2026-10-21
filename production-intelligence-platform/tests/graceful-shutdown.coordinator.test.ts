import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  GracefulShutdownCoordinator,
  type GracefulShutdownDependencies
} from "../src/services/graceful-shutdown.coordinator.js";

const createDependencies = () => {
  const calls: string[] = [];

  const dependencies: GracefulShutdownDependencies = {
    stopAcceptingWork: vi.fn(async () => {
      calls.push("stop");
    }),

    cancelActiveWork: vi.fn(async () => {
      calls.push("cancel");
    }),

    waitForActiveWork: vi.fn(async () => {
      calls.push("drain");
    }),

    closeResources: vi.fn(async () => {
      calls.push("close");
    })
  };

  return {
    calls,
    dependencies
  };
};

describe("GracefulShutdownCoordinator", () => {
  it("runs shutdown steps in the required order", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result).toEqual({
      status: "completed",
      errors: []
    });

    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("runs shutdown only once for repeated calls", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();

    expect(first).toBe(second);

    const [firstResult, secondResult] =
      await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("reports a timeout when active work does not finish", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    dependencies.waitForActiveWork =
      vi.fn(() => new Promise<void>(() => {}));

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 10 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("timed-out");

    expect(calls).toEqual([
      "stop",
      "cancel",
      "close"
    ]);

    expect(
      dependencies.closeResources
    ).toHaveBeenCalledTimes(1);
  });

  it("closes resources if stopping new work fails", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    dependencies.stopAcceptingWork =
      vi.fn(async () => {
        calls.push("stop");
        throw new Error("Unable to stop consumer");
      });

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("failed");

    expect(result.errors).toHaveLength(1);

    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("closes resources if cancellation fails", async () => {
    const {
      calls,
      dependencies
    } = createDependencies();

    dependencies.cancelActiveWork =
      vi.fn(async () => {
        calls.push("cancel");
        throw new Error("Cancellation failed");
      });

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("failed");
    expect(result.errors).toHaveLength(1);

    expect(calls).toEqual([
      "stop",
      "cancel",
      "drain",
      "close"
    ]);
  });

  it("reports failure if resource cleanup fails", async () => {
    const {
      dependencies
    } = createDependencies();

    dependencies.closeResources =
      vi.fn(async () => {
        throw new Error("Resource cleanup failed");
      });

    const coordinator =
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 100 }
      );

    const result = await coordinator.shutdown();

    expect(result.status).toBe("failed");
    expect(result.errors).toHaveLength(1);
  });

  it("rejects an invalid drain timeout", () => {
    const {
      dependencies
    } = createDependencies();

    expect(() =>
      new GracefulShutdownCoordinator(
        dependencies,
        { drainTimeoutMs: 0 }
      )
    ).toThrow(
      "drainTimeoutMs must be a positive safe integer"
    );
  });
});