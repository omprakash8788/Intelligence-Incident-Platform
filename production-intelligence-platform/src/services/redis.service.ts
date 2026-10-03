import {
  redis
} from "../redis/client.js";

export class RedisService {
  async set(
    key: string,
    value: string
  ): Promise<void> {
    await redis.set(
      key,
      value
    );
  }

  async get(
    key: string
  ): Promise<string | null> {
    return redis.get(key);
  }

  async delete(
    key: string
  ): Promise<void> {
    await redis.del(key);
  }

  async increment(
    key: string
  ): Promise<number> {
    return redis.incr(key);
  }

  async setWithExpiration(
    key: string,
    value: string,
    ttlSeconds: number
  ): Promise<void> {
    await redis.set(
      key,
      value,
      "EX",
      ttlSeconds
    );
  }
}

