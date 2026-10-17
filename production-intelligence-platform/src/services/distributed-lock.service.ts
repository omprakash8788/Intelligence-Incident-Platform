import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";

const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export class DistributedLockService {
  async acquire(
    resource: string,
    ttlMs: number
  ): Promise<string | null> {
    if (!resource.trim()) {
      throw new Error("Lock resource is required");
    }

    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Lock TTL must be a positive integer");
    }

    const key = `lock:${resource}`;
    const token = randomUUID();

    const result = await redis.set(
      key,
      token,
      "PX",
      ttlMs,
      "NX"
    );

    if (result !== "OK") {
      return null;
    }

    return token;
  }

  async release(
    resource: string,
    token: string
  ): Promise<boolean> {
    if (!resource.trim() || !token.trim()) {
      throw new Error("Lock resource and token are required");
    }

    const key = `lock:${resource}`;

    const result = await redis.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      key,
      token
    );

    return result === 1;
  }
}

export const distributedLockService =
  new DistributedLockService();