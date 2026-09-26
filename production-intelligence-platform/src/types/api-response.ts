export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiListResponse<T> {
  success: true;
  data: T[];
  meta: {
    page: number;
    limit: number;
    hasNextPage: boolean;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

