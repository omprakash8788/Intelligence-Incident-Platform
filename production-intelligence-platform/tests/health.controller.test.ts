import { describe, expect, it, vi } from "vitest";


import { healthController} from "../src/controllers/health.controller.js"
describe("healthController", () => {
  it("should return healthy status", () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };

    healthController({} as any, res as any);

    expect(res.status).toHaveBeenCalledWith(200);

    expect(res.json).toHaveBeenCalledWith({
      status: "ok",
      service: "production-intelligence-platform"
    });
  });
});