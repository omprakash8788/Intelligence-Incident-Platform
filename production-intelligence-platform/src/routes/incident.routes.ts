import { Router } from "express";
import { createIncident, getIncidentById, getIncidents } from "../controllers/incident.controller.js";
import { validate } from "../middleware/validation.middleware.js";
import { validateCreateIncident } from "../validators/incident.validator.js";
import { validateIncidentQuery } from "../validators/incident-query.validator.js";

const router = Router();

router.post(
  "/",
  validate(validateCreateIncident),
  createIncident
);

router.get(
  "/",
  validate(validateIncidentQuery),
  getIncidents
);

router.get("/:id", getIncidentById)

export default router;