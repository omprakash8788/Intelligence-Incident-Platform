import type {
  DemoJobMode,
  DemoJobPriority
} from "../queues/jobs/demo.job.js";

export type QueueTarget =
  | "demo"
  | "external-api";

export interface DemoQueueRequest {
  target: "demo";
  message: string;
  mode: DemoJobMode;
  priority?: DemoJobPriority;
}

export interface ExternalApiQueueRequest {
  target: "external-api";
  message: string;
}

export type QueueRoutingRequest =
  | DemoQueueRequest
  | ExternalApiQueueRequest;