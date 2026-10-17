import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    set: vi.fn(),
    eval: vi.fn()
  }
}));

vi.mock("../src/redis/client.js", () => ({
  redis: redisMock
}));

import { DistributedLockService } from
  "../src/services/distributed-lock.service.js";

describe("DistributedLockService", () => {
  let service: DistributedLockService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DistributedLockService();
  });

  it("returns a token when acquisition succeeds", async () => {
    redisMock.set.mockResolvedValue("OK");

    const token = await service.acquire("report:1001", 10_000);

    expect(token).toEqual(expect.any(String));
    expect(redisMock.set).toHaveBeenCalledWith(
      "lock:report:1001",
      token,
      "PX",
      10_000,
      "NX"
    );
  });

  it("returns null when another owner holds the lock", async () => {
    redisMock.set.mockResolvedValue(null);

    const token = await service.acquire("report:1001", 10_000);

    expect(token).toBeNull();
  });

  it("rejects an empty resource", async () => {
    await expect(service.acquire(" ", 10_000))
      .rejects.toThrow("Lock resource is required");

    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("rejects an invalid TTL", async () => {
    await expect(service.acquire("report:1001", 0))
      .rejects.toThrow("Lock TTL must be a positive integer");
  });

  it("releases a lock when the owner token matches", async () => {
    redisMock.eval.mockResolvedValue(1);

    await expect(
      service.release("report:1001", "owner-token")
    ).resolves.toBe(true);

    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1])'),
      1,
      "lock:report:1001",
      "owner-token"
    );
  });

  it("does not release a lock owned by someone else", async () => {
    redisMock.eval.mockResolvedValue(0);

    await expect(
      service.release("report:1001", "wrong-token")
    ).resolves.toBe(false);
  });

  it("rejects release with a missing token", async () => {
    await expect(service.release("report:1001", " "))
      .rejects.toThrow("Lock resource and token are required");

    expect(redisMock.eval).not.toHaveBeenCalled();
  });
});