import { describe, expect, it } from "vitest";

import {
  FencedResourcePolicy
} from "../src/services/fenced-resource.policy.js";

describe("FencedResourcePolicy", () => {
  it("accepts the first valid write", () => {
    const resource = new FencedResourcePolicy();

    const result = resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "leader-A"
    });

    expect(result).toEqual({
      accepted: true,
      highestToken: 41,
      reason: "accepted"
    });

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 41,
      value: "leader-A"
    });
  });

  it("allows multiple writes with the same token", () => {
    const resource = new FencedResourcePolicy();

    resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "first-write"
    });

    const secondWrite = resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "second-write"
    });

    expect(secondWrite.accepted).toBe(true);

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 41,
      value: "second-write"
    });
  });

  it("rejects a token older than the highest accepted token", () => {
    const resource = new FencedResourcePolicy();

    resource.write({
      resourceId: "account-1001",
      fencingToken: 42,
      value: "new-leader"
    });

    const staleWrite = resource.write({
      resourceId: "account-1001",
      fencingToken: 41,
      value: "old-leader"
    });

    expect(staleWrite).toEqual({
      accepted: false,
      highestToken: 42,
      reason: "stale-token"
    });

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 42,
      value: "new-leader"
    });
  });

  it("tracks fencing tokens independently per resource", () => {
    const resource = new FencedResourcePolicy();

    resource.write({
      resourceId: "account-1001",
      fencingToken: 42,
      value: "account-one"
    });

    const secondResourceWrite = resource.write({
      resourceId: "account-2002",
      fencingToken: 7,
      value: "account-two"
    });

    expect(secondResourceWrite.accepted).toBe(true);

    expect(
      resource.read("account-2002")
    ).toEqual({
      highestToken: 7,
      value: "account-two"
    });
  });

  it("rejects invalid fencing tokens", () => {
    const resource = new FencedResourcePolicy();

    expect(() =>
      resource.write({
        resourceId: "account-1001",
        fencingToken: 0,
        value: "invalid"
      })
    ).toThrow(
      "fencingToken must be a positive safe integer"
    );

    expect(() =>
      resource.write({
        resourceId: "account-1001",
        fencingToken: Number.NaN,
        value: "invalid"
      })
    ).toThrow(
      "fencingToken must be a positive safe integer"
    );
  });

  it("rejects an empty resource ID", () => {
    const resource = new FencedResourcePolicy();

    expect(() =>
      resource.write({
        resourceId: "   ",
        fencingToken: 41,
        value: "invalid"
      })
    ).toThrow("resourceId must not be empty");
  });

  it("rejects an old leader after a newer leader writes", async () => {
    const resource = new FencedResourcePolicy();

    let releaseOldLeader!: () => void;

    const oldLeaderMayContinue = new Promise<void>(
      (resolve) => {
        releaseOldLeader = resolve;
      }
    );

    const oldLeaderWrite = (async () => {
      // Simulate leader A pausing while it holds token 41.
      await oldLeaderMayContinue;

      return resource.write({
        resourceId: "account-1001",
        fencingToken: 41,
        value: "old-leader-result"
      });
    })();

    // Leader B has taken over and writes with token 42.
    const newLeaderWrite = resource.write({
      resourceId: "account-1001",
      fencingToken: 42,
      value: "new-leader-result"
    });

    expect(newLeaderWrite.accepted).toBe(true);

    // Allow the delayed operation from leader A to resume.
    releaseOldLeader();

    const staleResult = await oldLeaderWrite;

    expect(staleResult).toEqual({
      accepted: false,
      highestToken: 42,
      reason: "stale-token"
    });

    expect(
      resource.read("account-1001")
    ).toEqual({
      highestToken: 42,
      value: "new-leader-result"
    });
  });
});