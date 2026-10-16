export type WorkloadType =
  | "interactive"
  | "batch";

export interface WorkloadJobData {
  workloadId: string;
  workloadType: WorkloadType;
  message: string;
  submittedAt: string;
}

export interface WorkloadJobResult {
  workloadId: string;
  workloadType: WorkloadType;
  originalMessage: string;
  processedMessage: string;
  processedAt: string;
}