export interface FanoutTaskData {
  workflowId: string;
  itemId: string;
  value: string;
}

export interface FanoutTaskResult {
  workflowId: string;
  itemId: string;
  input: string;
  transformed: string;
}

export interface FanoutAggregateData {
  workflowId: string;
  expectedChildren: number;
}

export interface FanoutAggregateResult {
  workflowId: string;
  childCount: number;
  results: FanoutTaskResult[];
  completedAt: string;
}
