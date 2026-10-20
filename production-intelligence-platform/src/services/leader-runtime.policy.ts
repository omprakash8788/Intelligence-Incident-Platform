export type LeaderRuntimeState =
  | "stopped"
  | "acquiring"
  | "leader"
  | "follower"
  | "stopping";

export type LeaderRuntimeEvent =
  | "START"
  | "ACQUIRE_SUCCEEDED"
  | "ACQUIRE_FAILED"
  | "RENEW_SUCCEEDED"
  | "RENEW_FAILED"
  | "STOP";

const transitions: Record<
  LeaderRuntimeState,
  Partial<Record<LeaderRuntimeEvent, LeaderRuntimeState>>
> = {
  stopped: {
    START: "acquiring"
  },

  acquiring: {
    ACQUIRE_SUCCEEDED: "leader",
    ACQUIRE_FAILED: "follower",
    STOP: "stopping"
  },

  leader: {
    RENEW_SUCCEEDED: "leader",
    RENEW_FAILED: "follower",
    STOP: "stopping"
  },

  follower: {
    ACQUIRE_SUCCEEDED: "leader",
    ACQUIRE_FAILED: "follower",
    STOP: "stopping"
  },

  stopping: {
    STOP: "stopped"
  }
};

export function transitionLeaderRuntime(
  state: LeaderRuntimeState,
  event: LeaderRuntimeEvent
): LeaderRuntimeState {
  const nextState = transitions[state][event];

  if (!nextState) {
    throw new Error(
      `Invalid leader runtime transition: ${state} + ${event}`
    );
  }

  return nextState;
}