export interface FencedWriteRequest {
  resourceId: string;
  fencingToken: number;
  value: string;
}

export interface FencedWriteResult {
  accepted: boolean;
  highestToken: number;
  reason: "accepted" | "stale-token";
}

interface ResourceState {
  highestToken: number;
  value: string;
}

export class FencedResourcePolicy {
  private readonly resources = new Map<string, ResourceState>();

  write(request: FencedWriteRequest): FencedWriteResult {
    const {
      resourceId,
      fencingToken,
      value
    } = request;

    if (resourceId.trim().length === 0) {
      throw new Error("resourceId must not be empty");
    }

    if (
      !Number.isSafeInteger(fencingToken) ||
      fencingToken < 1
    ) {
      throw new Error(
        "fencingToken must be a positive safe integer"
      );
    }

    const current = this.resources.get(resourceId);

    const highestToken = current?.highestToken ?? 0;

    if (fencingToken < highestToken) {
      return {
        accepted: false,
        highestToken,
        reason: "stale-token"
      };
    }

    this.resources.set(resourceId, {
      highestToken: Math.max(
        highestToken,
        fencingToken
      ),
      value
    });

    return {
      accepted: true,
      highestToken: Math.max(
        highestToken,
        fencingToken
      ),
      reason: "accepted"
    };
  }

  read(resourceId: string): ResourceState | null {
    const state = this.resources.get(resourceId);

    if (!state) {
      return null;
    }

    return { ...state };
  }
}