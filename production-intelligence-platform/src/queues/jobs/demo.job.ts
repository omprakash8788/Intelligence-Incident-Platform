export type DemoJobMode =
  | "success"
  | "slow"
  | "failure";

export interface DemoJobData {
  message: string;
  mode: DemoJobMode;
}

