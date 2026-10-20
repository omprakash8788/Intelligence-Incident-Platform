import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  LeaderLeaseProvider
} from "../src/services/leader-lease-provider.service.js";

import type {
  LeaderLeaseService
} from "../src/services/leader-lease-provider.types.js";

interface TestLease {
  electionName: string;
  leaderId: string;
  fencingToken: string;
}

function createTestService() {
  const lease: TestLease = {
    electionName: "incident-scheduler",
    leaderId: "worker-a",
    fencingToken: "10"
  };

  const service: LeaderLeaseService<TestLease> = {
    acquireLeadership: vi.fn().mockResolvedValue(
      lease
    ),

    renewLeadership: vi.fn().mockResolvedValue(
      lease
    ),

    releaseLeadership: vi.fn().mockResolvedValue(
      true
    )
  };

  return {
    lease,
    service
  };
}

describe("LeaderLeaseProvider", () => {
  it("rejects an empty election name", () => {
    const { service } = createTestService();

    expect(
      () =>
        new LeaderLeaseProvider({
          service,
          config: {
            electionName: " ",
            leaderId: "worker-a",
            leaseMs: 15_000
          }
        })
    ).toThrow(
      "electionName must not be empty"
    );
  });

  it("rejects an empty leader ID", () => {
    const { service } = createTestService();

    expect(
      () =>
        new LeaderLeaseProvider({
          service,
          config: {
            electionName: "incident-scheduler",
            leaderId: " ",
            leaseMs: 15_000
          }
        })
    ).toThrow(
      "leaderId must not be empty"
    );
  });

  it("rejects a non-positive lease duration", () => {
    const { service } = createTestService();

    expect(
      () =>
        new LeaderLeaseProvider({
          service,
          config: {
            electionName: "incident-scheduler",
            leaderId: "worker-a",
            leaseMs: 0
          }
        })
    ).toThrow(
      "leaseMs must be a positive safe integer"
    );
  });

  it("forwards acquisition arguments", async () => {
    const { lease, service } = createTestService();

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(provider.acquire()).resolves.toEqual(
      lease
    );

    expect(
      service.acquireLeadership
    ).toHaveBeenCalledWith(
      "incident-scheduler",
      "worker-a",
      15_000
    );
  });

  it("forwards the lease during renewal", async () => {
    const { lease, service } = createTestService();

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(
      provider.renew(lease)
    ).resolves.toEqual(lease);

    expect(
      service.renewLeadership
    ).toHaveBeenCalledWith(
      lease,
      15_000
    );
  });

  it("forwards the lease during release", async () => {
    const { lease, service } = createTestService();

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(
      provider.release(lease)
    ).resolves.toBe(true);

    expect(
      service.releaseLeadership
    ).toHaveBeenCalledWith(lease);
  });

  it("propagates acquisition failures", async () => {
    const { service } = createTestService();

    vi.mocked(service.acquireLeadership)
      .mockRejectedValueOnce(
        new Error("Database unavailable")
      );

    const provider = new LeaderLeaseProvider({
      service,
      config: {
        electionName: "incident-scheduler",
        leaderId: "worker-a",
        leaseMs: 15_000
      }
    });

    await expect(
      provider.acquire()
    ).rejects.toThrow("Database unavailable");
  });
});