import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  LeaderRuntime,
  type LeaderHooks,
  type LeaseProvider
} from "../src/services/leader-runtime.service.js";

interface TestLease {
  leaderId: string;
  fencingToken: string;
}

function createDependencies() {
  const lease: TestLease = {
    leaderId: "worker-a",
    fencingToken: "1"
  };

  const leaseProvider: LeaseProvider<TestLease> = {
    acquire: vi.fn().mockResolvedValue(lease),
    renew: vi.fn().mockResolvedValue(lease),
    release: vi.fn().mockResolvedValue(true)
  };

  const hooks: LeaderHooks = {
    onLeadershipAcquired: vi.fn().mockResolvedValue(
      undefined
    ),
    onLeadershipLost: vi.fn().mockResolvedValue(
      undefined
    )
  };

  return {
    lease,
    leaseProvider,
    hooks
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LeaderRuntime", () => {
  it("rejects an invalid retry interval", () => {
    const dependencies = createDependencies();

    expect(
      () =>
        new LeaderRuntime({
          ...dependencies,
          config: {
            retryIntervalMs: 0
          }
        })
    ).toThrow(
      "retryIntervalMs must be a positive safe integer"
    );
  });

  it("acquires leadership and calls the acquisition hook", async () => {
    const dependencies = createDependencies();

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 10_000
      }
    });

    await runtime.start();

    // Allow the asynchronous loop to perform acquisition.
    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("leader");
    });

    expect(
      dependencies.leaseProvider.acquire
    ).toHaveBeenCalledTimes(1);

    expect(
      dependencies.hooks.onLeadershipAcquired
    ).toHaveBeenCalledTimes(1);

    await runtime.stop();

    expect(runtime.getState()).toBe("stopped");
  });

//   it("moves to follower when renewal fails", async () => {
//     const dependencies = createDependencies();

//     dependencies.leaseProvider.renew =
//       vi.fn().mockResolvedValue(null);

//     const runtime = new LeaderRuntime({
//       ...dependencies,
//       config: {
//         retryIntervalMs: 5
//       }
//     });

//     await runtime.start();

//     await vi.waitFor(() => {
//       expect(runtime.getState()).toBe("follower");
//     });

//     expect(
//       dependencies.hooks.onLeadershipLost
//     ).toHaveBeenCalledTimes(1);

//     await runtime.stop();
//   });

it("moves to follower when renewal fails", async () => {
  const dependencies = createDependencies();

  // Grant leadership only once.
  // All subsequent acquisition attempts return null.
  dependencies.leaseProvider.acquire = vi
    .fn()
    .mockResolvedValueOnce(dependencies.lease)
    .mockResolvedValue(null);

  // Simulate a failed renewal.
  dependencies.leaseProvider.renew = vi
    .fn()
    .mockResolvedValue(null);

  const runtime = new LeaderRuntime({
    ...dependencies,
    config: {
      retryIntervalMs: 5
    }
  });

  await runtime.start();

  try {
    await vi.waitFor(() => {
      expect(
        dependencies.hooks.onLeadershipLost
      ).toHaveBeenCalledTimes(1);
    });

    expect(runtime.getState()).toBe("follower");

    expect(
      dependencies.hooks.onLeadershipAcquired
    ).toHaveBeenCalledTimes(1);

    expect(
      dependencies.leaseProvider.renew
    ).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.stop();
  }

  expect(runtime.getState()).toBe("stopped");

  // Shutdown must not report the same leadership loss twice.
  expect(
    dependencies.hooks.onLeadershipLost
  ).toHaveBeenCalledTimes(1);
});

  it("releases the lease during shutdown", async () => {
    const dependencies = createDependencies();

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 10_000
      }
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("leader");
    });

    await runtime.stop();

    expect(
      dependencies.leaseProvider.release
    ).toHaveBeenCalledWith(dependencies.lease);

    expect(runtime.getState()).toBe("stopped");
  });

  it("makes repeated stop calls safe", async () => {
    const dependencies = createDependencies();

    const runtime = new LeaderRuntime({
      ...dependencies,
      config: {
        retryIntervalMs: 10_000
      }
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(runtime.getState()).toBe("leader");
    });

    await Promise.all([
      runtime.stop(),
      runtime.stop()
    ]);

    expect(runtime.getState()).toBe("stopped");

    expect(
      dependencies.leaseProvider.release
    ).toHaveBeenCalledTimes(1);
  });
});