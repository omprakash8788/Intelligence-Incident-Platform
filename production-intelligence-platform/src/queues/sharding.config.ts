export const SHARD_COUNT = 3;

export const SHARDED_QUEUE_NAMES = [
  "sharded-workload-0",
  "sharded-workload-1",
  "sharded-workload-2"
] as const;

if (SHARDED_QUEUE_NAMES.length !== SHARD_COUNT) {
  throw new Error(
    "SHARD_COUNT must match SHARDED_QUEUE_NAMES.length"
  );
}