export interface ParentChildItemData {
  batchId: string;
  index: number;
  value: string;
}

export interface ParentChildItemResult {
  batchId: string;
  index: number;
  originalValue: string;
  normalizedValue: string;
}

export interface ParentChildParentData {
  batchId: string;
  itemCount: number;
}

export interface ParentChildParentResult {
  batchId: string;
  completedCount: number;
  items: ParentChildItemResult[];
  summary: string;
}

