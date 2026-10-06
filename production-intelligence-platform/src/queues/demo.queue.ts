import {
  Queue
} from "bullmq";

import {
  createBullMQConnection
} from "./bullmq.connection.js";

export const DEMO_QUEUE_NAME =
  "demo-job";

export const demoQueue =
  new Queue(
    DEMO_QUEUE_NAME,
    {
      connection:
        createBullMQConnection(
          1
        )
    }
  );


  