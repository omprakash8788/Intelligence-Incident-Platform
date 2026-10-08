export type DemoJobMode =
  | "success"
  | "slow"
  | "failure"
  | "fail-twice";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}

