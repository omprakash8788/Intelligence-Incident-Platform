export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice"
  | "retryable"
  | "non-retryable";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}

