import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  addDemoJob
} from "../src/queues/producers/demo.producer.js";

import {
  enqueueExternalApiRequest
} from "../src/queues/producers/external-api.producer.js";

import {
  routeQueueJob
} from "../src/services/queue-routing.service.js";

vi.mock(
  "../src/queues/producers/demo.producer.js",
  () => ({
    addDemoJob: vi.fn()
  })
);

vi.mock(
  "../src/queues/producers/external-api.producer.js",
  () => ({
    enqueueExternalApiRequest: vi.fn()
  })
);

describe(
  "queue routing service",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it(
      "routes demo jobs to the demo producer",
      async () => {
        vi.mocked(addDemoJob).mockResolvedValue("demo-job-1");

        const result = await routeQueueJob({
          target: "demo",
          message: "Process incident",
          mode: "success",
          priority: 1
        });

        expect(addDemoJob).toHaveBeenCalledWith(
          {
            message: "Process incident",
            mode: "success"
          },
          {
            priority: 1
          }
        );

        expect(
          enqueueExternalApiRequest
        ).not.toHaveBeenCalled();

        expect(result).toEqual({
          jobId: "demo-job-1"
        });
      }
    );

    it(
      "routes external API jobs to the external API producer",
      async () => {
        vi.mocked(
          enqueueExternalApiRequest
        ).mockResolvedValue({
          jobId: "external-job-1"
        } as Awaited<
          ReturnType<
            typeof enqueueExternalApiRequest
          >
        >);

        const result = await routeQueueJob({
          target: "external-api",
          message: "Notify external service"
        });

        expect(
          enqueueExternalApiRequest
        ).toHaveBeenCalledWith(
          "Notify external service"
        );

        expect(addDemoJob).not.toHaveBeenCalled();

        expect(result).toEqual({
          jobId: "external-job-1"
        });
      }
    );
  }
);