import type { Response } from "express";

export const sendSuccess = <T>(
  res: Response,
  statusCode: number,
  data: T
) => {
  return res.status(statusCode).json({
    success: true,
    data
  });
};


export const sendListSuccess = <T>(
  res: Response,
  data: T[],
  meta: {
    page: number;
    limit: number;
    hasNextPage: boolean;
  }
) => {
  return res.status(200).json({
    success: true,
    data,
    meta
  });
};

