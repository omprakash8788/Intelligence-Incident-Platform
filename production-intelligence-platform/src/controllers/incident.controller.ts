import { Request, Response } from "express";

export const createIncident = (
  req: Request,
  res: Response
) => {
  const { service, severity } = req.body;

  res.status(201).json({
    success: true,
    data: {
      service,
      severity
    }
  });
};

