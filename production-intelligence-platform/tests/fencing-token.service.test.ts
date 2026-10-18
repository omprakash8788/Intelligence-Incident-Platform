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
  FencingTokenService
} from "../src/services/fencing-token.service.js";

describe("FencingTokenService", () => {
  let service: FencingTokenService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FencingTokenService();
  });

  it("allocates and returns a fencing token", async () => {
    poolMock.query.mockResolvedValue({
      rows: [{ token: "41" }],
      rowCount: 1
    });

    await expect(
      service.allocateToken("report:1001")
    ).resolves.toBe("41");

    expect(poolMock.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "last_token = lock_fencing_state.last_token + 1"
      ),
      ["report:1001"]
    );
  });

  it("rejects an empty resource key", async () => {
    await expect(
      service.allocateToken(" ")
    ).rejects.toThrow("Resource key is required");

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("accepts a newer fencing token", async () => {
    poolMock.query.mockResolvedValue({
      rows: [
        {
          resource_key: "report:1001",
          fencing_token: "42",
          operation_id: "operation-B"
        }
      ],
      rowCount: 1
    });

    await expect(
      service.applyFencedWrite(
        "report:1001",
        "42",
        "operation-B"
      )
    ).resolves.toEqual({
      accepted: true,
      resourceKey: "report:1001",
      fencingToken: "42",
      operationId: "operation-B"
    });
  });

  it("rejects a stale fencing token", async () => {
    poolMock.query.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    await expect(
      service.applyFencedWrite(
        "report:1001",
        "41",
        "operation-A"
      )
    ).resolves.toEqual({
      accepted: false,
      resourceKey: "report:1001",
      fencingToken: "41",
      operationId: "operation-A"
    });
  });

  it("rejects a non-numeric fencing token", async () => {
    await expect(
      service.applyFencedWrite(
        "report:1001",
        "token-42",
        "operation-A"
      )
    ).rejects.toThrow(
      "Fencing token must be a positive integer string"
    );

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("rejects an empty operation ID", async () => {
    await expect(
      service.applyFencedWrite(
        "report:1001",
        "42",
        " "
      )
    ).rejects.toThrow("Operation ID is required");

    expect(poolMock.query).not.toHaveBeenCalled();
  });
});