// import { Request, Response, NextFunction } from "express";
// import { IncidentRepository } from "../repositories/incident.repository.js";
// import { IncidentService } from "../services/incident.service.js";

// const incidentRepository =
//   new IncidentRepository();

// const incidentService =
//   new IncidentService(incidentRepository);

// export const createIncident = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const incident =
//       await incidentService.createIncidentWithEvent({
//         service: req.body.service,
//         severity: req.body.severity
//       });

//     res.status(201).json({
//       success: true,
//       data: incident
//     });
//   } catch (error) {
//     next(error);
//   }
// };

// export const getIncidentById = async (
//   req: Request,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const incident = await incidentService.getIncidentById(req.params.id as any);
//     res.status(200).json({
//       success: true,
//       data: incident
//     });
//   } catch (error) {
//     next(error);
//   }
// };

import {
  Request,
  Response,
  NextFunction
} from "express";

import { incidentService } from "../container.js";

export const createIncident = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    const incident =
      await incidentService.createIncidentWithEvent({
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

export const getIncidents = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    const page = Number(
      req.query.page ?? 1
    );

    const limit = Number(
      req.query.limit ?? 20
    );

    const incidents =
      await incidentService.getIncidents({
        page,
        limit,
        service:
          typeof req.query.service === "string"
            ? req.query.service
            : undefined,
        severity:
          typeof req.query.severity === "string"
            ? req.query.severity as any
            : undefined,
        status:
          typeof req.query.status === "string"
            ? req.query.status as any
            : undefined
      });

    res.status(200).json({
      success: true,
      data: incidents
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

    const incident =
      await incidentService.getIncidentById(
        req.params.id as string
      );

    res.status(200).json({
      success: true,
      data: incident
    });

  } catch (error) {
    next(error);
  }
};