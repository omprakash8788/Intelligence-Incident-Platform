export type CrashWindow =
  | "before-transaction-commit"
  | "after-transaction-commit"
  | "after-claim-before-delivery"
  | "delivery-outcome-unknown"
  | "after-delivery-before-published-mark"
  | "after-published-mark";

export type RecoveryAction =
  | "resolve-transaction-outcome"
  | "claim-pending-event"
  | "wait-for-lease-expiry-or-reclaim"
  | "retry-with-deduplication"
  | "reconcile-durable-state"
  | "no-republish-required";

export interface CrashRecoveryPlan {
  action: RecoveryAction;
  duplicateDeliveryPossible: boolean;
  businessEffectMayAlreadyHaveOccurred: boolean;
  explanation: string;
}

const RECOVERY_PLANS: Record<CrashWindow, CrashRecoveryPlan> = {
  "before-transaction-commit": {
    action: "resolve-transaction-outcome",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: false,
    explanation:
      "Resolve whether the database transaction committed before retrying the logical operation."
  },

  "after-transaction-commit": {
    action: "claim-pending-event",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: false,
    explanation:
      "The committed outbox event is durable and can be claimed for publication."
  },

  "after-claim-before-delivery": {
    action: "wait-for-lease-expiry-or-reclaim",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: false,
    explanation:
      "The claim may belong to a crashed publisher; reclaim the event according to the lease policy."
  },

  "delivery-outcome-unknown": {
    action: "retry-with-deduplication",
    duplicateDeliveryPossible: true,
    businessEffectMayAlreadyHaveOccurred: true,
    explanation:
      "The destination may have accepted the event even though the publisher did not receive confirmation."
  },

  "after-delivery-before-published-mark": {
    action: "retry-with-deduplication",
    duplicateDeliveryPossible: true,
    businessEffectMayAlreadyHaveOccurred: true,
    explanation:
      "The destination may have processed the event before the publisher crashed."
  },

  "after-published-mark": {
    action: "no-republish-required",
    duplicateDeliveryPossible: false,
    businessEffectMayAlreadyHaveOccurred: true,
    explanation:
      "The publisher recorded successful delivery; ordinary recovery should not republish this event."
  }
};

export function getCrashRecoveryPlan(
  window: CrashWindow
): CrashRecoveryPlan {
  return { ...RECOVERY_PLANS[window] };
}