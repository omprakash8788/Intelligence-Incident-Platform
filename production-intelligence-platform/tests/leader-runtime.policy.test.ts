import { describe, expect, it } from "vitest";

import {
  transitionLeaderRuntime
} from "../src/services/leader-runtime.policy.js";

describe("transitionLeaderRuntime", () => {
  it("starts in acquiring state", () => {
    expect(
      transitionLeaderRuntime("stopped", "START")
    ).toBe("acquiring");
  });

  it("transitions to leader after acquisition", () => {
    expect(
      transitionLeaderRuntime(
        "acquiring",
        "ACQUIRE_SUCCEEDED"
      )
    ).toBe("leader");
  });

  it("transitions to follower after acquisition failure", () => {
    expect(
      transitionLeaderRuntime(
        "acquiring",
        "ACQUIRE_FAILED"
      )
    ).toBe("follower");
  });

  it("loses leadership after renewal failure", () => {
    expect(
      transitionLeaderRuntime(
        "leader",
        "RENEW_FAILED"
      )
    ).toBe("follower");
  });

  it("remains leader after successful renewal", () => {
    expect(
      transitionLeaderRuntime(
        "leader",
        "RENEW_SUCCEEDED"
      )
    ).toBe("leader");
  });

  it("rejects invalid transitions", () => {
    expect(() =>
      transitionLeaderRuntime(
        "stopped",
        "RENEW_SUCCEEDED"
      )
    ).toThrow(
      "Invalid leader runtime transition"
    );
  });
});