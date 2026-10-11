export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable"
  | "delayed"
  | "progress";


export type DemoJobPriority =
  | 1
  | 2
  | 5
  | 10;

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
  priority: DemoJobPriority;
}

export interface DemoJobProgress {
  completed: number;
  total: number;
  percentage: number;
  currentStep: string;
}



