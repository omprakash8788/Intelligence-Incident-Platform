import { Request, Response, NextFunction } from "express";
import { IncidentRepository } from "../repositories/incident.repository.js";
import { IncidentService } from "../services/incident.service.js";

const incidentRepository =
  new IncidentRepository();

const incidentService =
  new IncidentService(incidentRepository);

export const createIncident = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const incident =
      await incidentService.createIncident({
        service: req.body.service,
        severity: req.body.severity
      });

    res.status(201).json({
      success: true,
      data: incident
    });
  } catch (error) {
    next(error);
  }
};

export const getIncidentById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const incident = await incidentService.getIncidentById(req.params.id as any);
    res.status(200).json({
      success: true,
      data: incident
    });
  } catch (error) {
    next(error);
  }
};