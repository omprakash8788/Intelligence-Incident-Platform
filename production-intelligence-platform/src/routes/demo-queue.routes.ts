import {
  Router
} from "express";

import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

const router =
  Router();

router.post(
  "/demo/jobs",
  async (
    _req,
    res,
    next
  ) => {

    try {

      const jobId =
        await addDemoJob({
          message:
            "Hello from Production Intelligence Platform"
        });

      res.status(202).json({
        success: true,
        data: {
          jobId
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

export default router;

