export interface PaginatedResult<T> {
  items: T[];
  hasNextPage: boolean;
}

