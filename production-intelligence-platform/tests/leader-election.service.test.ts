import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    query: vi.fn()
  }
}));

vi.mock("../src/database/pool.js", () => ({
  pool: poolMock
}));

import {
  LeaderElectionService
} from "../src/services/leader-election.service.js";

describe("LeaderElectionService", () => {
  let service: LeaderElectionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LeaderElectionService();
  });

  it("acquires leadership when the database grants a lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [
        {
          election_name: "incident-reconciliation",
          leader_id: "instance-A",
          fencing_token: "1",
          lease_expires_at: new Date(
            "2026-10-19T12:00:30.000Z"
          )
        }
      ],
      rowCount: 1
    });

    const lease = await service.acquireLeadership(
      "incident-reconciliation",
      "instance-A",
      30_000
    );

    expect(lease).toEqual({
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "1",
      leaseExpiresAt: new Date(
        "2026-10-19T12:00:30.000Z"
      )
    });
  });

  it("returns null when another leader holds the lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const lease = await service.acquireLeadership(
      "incident-reconciliation",
      "instance-B",
      30_000
    );

    expect(lease).toBeNull();
  });

  it("rejects an empty election name", async () => {
    await expect(
      service.acquireLeadership(" ", "instance-A", 30_000)
    ).rejects.toThrow("Election name is required");

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("rejects an invalid lease duration", async () => {
    await expect(
      service.acquireLeadership(
        "incident-reconciliation",
        "instance-A",
        0
      )
    ).rejects.toThrow(
      "Lease duration must be between 1000 and 300000 milliseconds"
    );

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("renews a currently owned lease", async () => {
    const currentLease = {
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "7",
      leaseExpiresAt: new Date(
        "2026-10-19T12:00:30.000Z"
      )
    };

    poolMock.query.mockResolvedValue({
      rows: [
        {
          election_name: currentLease.electionName,
          leader_id: currentLease.leaderId,
          fencing_token: "7",
          lease_expires_at: new Date(
            "2026-10-19T12:01:00.000Z"
          )
        }
      ],
      rowCount: 1
    });

    const renewed = await service.renewLeadership(
      currentLease,
      30_000
    );

    expect(renewed?.fencingToken).toBe("7");
    expect(poolMock.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "AND fencing_token = $3::bigint"
      ),
      [
        currentLease.electionName,
        currentLease.leaderId,
        currentLease.fencingToken,
        30_000
      ]
    );
  });

  it("returns null when renewal no longer owns the lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const renewed = await service.renewLeadership(
      {
        electionName: "incident-reconciliation",
        leaderId: "instance-A",
        fencingToken: "7",
        leaseExpiresAt: new Date()
      },
      30_000
    );

    expect(renewed).toBeNull();
  });

  it("releases a lease only when the database confirms ownership", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 1
    });

    const released = await service.releaseLeadership({
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "7",
      leaseExpiresAt: new Date()
    });

    expect(released).toBe(true);
  });

  it("reports false when release does not match the current lease", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const released = await service.releaseLeadership({
      electionName: "incident-reconciliation",
      leaderId: "instance-A",
      fencingToken: "6",
      leaseExpiresAt: new Date()
    });

    expect(released).toBe(false);
  });
});