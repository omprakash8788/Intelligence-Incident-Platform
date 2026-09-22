// import { Request, Response } from "express";

// export const healthController = (
//   _req: Request,
//   res: Response
// ) => {
//   res.status(200).json({
//     status: "ok",
//     service: "production-intelligence-platform"
//   });
// };

import { Request, Response, NextFunction } from "express";
import { checkDatabaseConnection } from "../database/health.js";

export const healthController = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await checkDatabaseConnection();

    res.status(200).json({
      status: "ok",
      service: "production-intelligence-platform",
      database: "connected"
    });
  } catch (error) {
    next(error);
  }
};
