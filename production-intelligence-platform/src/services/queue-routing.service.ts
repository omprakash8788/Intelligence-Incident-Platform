import {
  addDemoJob
} from "../queues/producers/demo.producer.js";

import {
  enqueueExternalApiRequest
} from "../queues/producers/external-api.producer.js";

import type {
  QueueRoutingRequest
} from "./queue-routing.types.js";

export const routeQueueJob = async (
  request: QueueRoutingRequest
) => {
  switch (request.target) {
    case "demo": {
      return addDemoJob(
        {
          message: request.message,
          mode: request.mode
        },
        {
          priority: request.priority
        }
      );
    }

    case "external-api": {
      return enqueueExternalApiRequest(
        request.message
      );
    }

    default: {
      const exhaustiveCheck: never = request;

      throw new Error(
        `Unsupported queue request: ${String(exhaustiveCheck)}`
      );
    }
  }
};
