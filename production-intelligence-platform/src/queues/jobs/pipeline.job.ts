export interface PipelineNormalizeData {
  workflowId: string;
  originalText: string;
}

export interface PipelineNormalizeResult {
  workflowId: string;
  originalText: string;
  normalizedText: string;
}

export interface PipelineAnalyzeData {
  workflowId: string;
}

export interface PipelineAnalyzeResult {
  workflowId: string;
  originalText: string;
  normalizedText: string;
  wordCount: number;
  characterCount: number;
}

export interface PipelineReportData {
  workflowId: string;
}

export interface PipelineReportResult {
  workflowId: string;
  originalText: string;
  normalizedText: string;
  wordCount: number;
  characterCount: number;
  status: "completed";
  completedAt: string;
}

