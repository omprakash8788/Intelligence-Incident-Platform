export interface ExternalApiJobData {
  requestId: string;
  message: string;
}

export interface ExternalApiJobResult {
  requestId: string;
  processedAt: string;
  success: boolean;
}

