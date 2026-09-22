import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";
// import { NotFoundError } from "../errors/NotFoundError.js";

const router = Router();

router.get("/", healthController);

// router.get("/test-error", () => {
//   throw new NotFoundError(
//     "Test incident does not exist",
//     "INCIDENT_NOT_FOUND"
//   );
// });

// router.get("/test-unknown-error", () => {
//   throw new Error("Database exploded");
// });

export default router;