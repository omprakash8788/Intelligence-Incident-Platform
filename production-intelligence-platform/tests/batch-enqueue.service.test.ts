import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/queues/demo.queue.js", () => ({
  demoQueue: {
    addBulk: vi.fn()
  }
}));

import { demoQueue } from "../src/queues/demo.queue.js";
import { enqueueDemoBatch } from "../src/services/batch-enqueue.service.js";

describe("enqueueDemoBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits multiple jobs in one bulk call", async () => {
    vi.mocked(demoQueue.addBulk).mockResolvedValue([
      { id: "job-1" },
      { id: "job-2" }
    ] as Awaited<ReturnType<typeof demoQueue.addBulk>>);

    const result = await enqueueDemoBatch([
      "Incident A",
      "Incident B"
    ]);

    expect(demoQueue.addBulk).toHaveBeenCalledTimes(1);

    expect(demoQueue.addBulk).toHaveBeenCalledWith([
      {
        name: "batch-demo-job",
        data: {
          message: "Incident A",
          mode: "success",
          priority: 5
        }
      },
      {
        name: "batch-demo-job",
        data: {
          message: "Incident B",
          mode: "success",
          priority: 5
        }
      }
    ]);

    expect(result).toEqual({
      count: 2,
      jobIds: ["job-1", "job-2"]
    });
  });

  it("trims message whitespace", async () => {
    vi.mocked(demoQueue.addBulk).mockResolvedValue([
      { id: "job-1" }
    ] as Awaited<ReturnType<typeof demoQueue.addBulk>>);

    const result = await enqueueDemoBatch([
      "  Incident A  "
    ]);

    expect(demoQueue.addBulk).toHaveBeenCalledWith([
      {
        name: "batch-demo-job",
        data: {
          message: "Incident A",
          mode: "success",
          priority: 5
        }
      }
    ]);

    expect(result.jobIds).toEqual(["job-1"]);
  });

  it("rejects an empty batch before enqueueing", async () => {
    await expect(
      enqueueDemoBatch([])
    ).rejects.toThrow(RangeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than 100 items", async () => {
    const messages = Array.from(
      { length: 101 },
      (_, index) => `Incident ${index + 1}`
    );

    await expect(
      enqueueDemoBatch(messages)
    ).rejects.toThrow(RangeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("rejects a blank message", async () => {
    await expect(
      enqueueDemoBatch(["   "])
    ).rejects.toThrow(TypeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("rejects a message longer than 500 characters", async () => {
    await expect(
      enqueueDemoBatch(["a".repeat(501)])
    ).rejects.toThrow(TypeError);

    expect(demoQueue.addBulk).not.toHaveBeenCalled();
  });

  it("propagates an enqueue failure", async () => {
    vi.mocked(demoQueue.addBulk).mockRejectedValue(
      new Error("Redis unavailable")
    );

    await expect(
      enqueueDemoBatch(["Incident A"])
    ).rejects.toThrow("Redis unavailable");
  });
});