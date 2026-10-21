import { describe, expect, it } from "vitest";

import {
  getCrashRecoveryPlan,
  type CrashWindow
} from "../src/services/crash-window.policy.js";

describe("getCrashRecoveryPlan", () => {
  it("resolves transaction outcome before retrying", () => {
    const plan = getCrashRecoveryPlan(
      "before-transaction-commit"
    );

    expect(plan.action).toBe(
      "resolve-transaction-outcome"
    );

    expect(plan.duplicateDeliveryPossible).toBe(false);
  });

  it("claims an event after the transaction commits", () => {
    const plan = getCrashRecoveryPlan(
      "after-transaction-commit"
    );

    expect(plan.action).toBe("claim-pending-event");
    expect(plan.businessEffectMayAlreadyHaveOccurred).toBe(
      false
    );
  });

  it("reclaims a claim after the publisher crashes", () => {
    const plan = getCrashRecoveryPlan(
      "after-claim-before-delivery"
    );

    expect(plan.action).toBe(
      "wait-for-lease-expiry-or-reclaim"
    );

    expect(plan.duplicateDeliveryPossible).toBe(false);
  });

  it("treats an unknown delivery outcome as potentially successful", () => {
    const plan = getCrashRecoveryPlan(
      "delivery-outcome-unknown"
    );

    expect(plan.action).toBe("retry-with-deduplication");
    expect(plan.duplicateDeliveryPossible).toBe(true);
    expect(plan.businessEffectMayAlreadyHaveOccurred).toBe(
      true
    );
  });

  it("accounts for a crash after delivery but before acknowledgement", () => {
    const plan = getCrashRecoveryPlan(
      "after-delivery-before-published-mark"
    );

    expect(plan.action).toBe("retry-with-deduplication");
    expect(plan.duplicateDeliveryPossible).toBe(true);
    expect(plan.explanation).toContain(
      "before the publisher crashed"
    );
  });

  it("does not normally republish an event already marked published", () => {
    const plan = getCrashRecoveryPlan("after-published-mark");

    expect(plan.action).toBe("no-republish-required");
    expect(plan.businessEffectMayAlreadyHaveOccurred).toBe(
      true
    );
  });

  it("provides a recovery plan for every crash window", () => {
    const windows: CrashWindow[] = [
      "before-transaction-commit",
      "after-transaction-commit",
      "after-claim-before-delivery",
      "delivery-outcome-unknown",
      "after-delivery-before-published-mark",
      "after-published-mark"
    ];

    for (const window of windows) {
      const plan = getCrashRecoveryPlan(window);

      expect(plan.action.length).toBeGreaterThan(0);
      expect(plan.explanation.length).toBeGreaterThan(0);
    }
  });

  it("does not expose the stored plan for direct mutation", () => {
    const first = getCrashRecoveryPlan(
      "delivery-outcome-unknown"
    );

    first.action = "no-republish-required";

    const second = getCrashRecoveryPlan(
      "delivery-outcome-unknown"
    );

    expect(second.action).toBe("retry-with-deduplication");
  });
});