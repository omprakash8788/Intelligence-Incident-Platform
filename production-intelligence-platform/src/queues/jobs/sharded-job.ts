export interface ShardedJobData {
  partitionKey: string;
  shardIndex: number;
  message: string;
  submittedAt: string;
}

export interface ShardedJobResult {
  partitionKey: string;
  shardIndex: number;
  originalMessage: string;
  processedMessage: string;
  processedAt: string;
}