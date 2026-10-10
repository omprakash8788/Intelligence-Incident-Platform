export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable"
  | "delayed";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}

