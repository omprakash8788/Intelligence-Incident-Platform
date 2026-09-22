import { Router } from "express";
import { createIncident, getIncidentById } from "../controllers/incident.controller.js";
import { validate } from "../middleware/validation.middleware.js";
import { validateCreateIncident } from "../validators/incident.validator.js";

const router = Router();

router.post(
  "/",
  validate(validateCreateIncident),
  createIncident
);

router.get("/:id", getIncidentById)

export default router;