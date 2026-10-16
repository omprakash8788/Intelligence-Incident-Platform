import {
  SHARD_COUNT
} from "../queues/sharding.config.js";

export const resolveShardIndex = (
  partitionKey: string,
  shardCount: number = SHARD_COUNT
): number => {
  if (
    typeof partitionKey !== "string" ||
    partitionKey.trim().length === 0
  ) {
    throw new TypeError(
      "Partition key must be a non-empty string"
    );
  }

  if (
    !Number.isInteger(shardCount) ||
    shardCount <= 0
  ) {
    throw new RangeError(
      "Shard count must be a positive integer"
    );
  }

  const normalizedKey = partitionKey.trim();

  let hash = 2166136261;

  for (let index = 0; index < normalizedKey.length; index++) {
    hash ^= normalizedKey.charCodeAt(index);

    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash % shardCount;
};