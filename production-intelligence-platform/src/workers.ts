// import {
//   demoWorker
// } from "./workers/demo.worker.js";

// import {
//   startDemoQueueEvents,
//   closeDemoQueueEvents
// } from "./queues/demo.queue-events.js";


// import {
//   logger
// } from "./logging/logger.js";

// import {
//   externalApiWorker
// } from "./workers/external-api.worker.js";

// let isShuttingDown = false;

// // console.log(
// //   "Worker process started"
// // );

// const start =
//   async (): Promise<void> => {
//     try {
//       await startDemoQueueEvents();

//       await demoWorker.waitUntilReady();

//       await externalApiWorker.waitUntilReady();

//       logger.info(
//         "Worker process started"
//       );
//     } catch (error) {
//       logger.error(
//         "Worker process startup failed",
//         {
//           error:
//             error instanceof Error
//               ? error.message
//               : String(error)
//         }
//       );
//     }
//       await Promise.allSettled([
//       demoWorker.close(),
//       externalApiWorker.close(),
//       closeDemoQueueEvents()
//     ]);

//     process.exitCode = 1;
//   };

// const shutdown =
//   async (
//     signal: string
//   ): Promise<void> => {
//     if (isShuttingDown) {
//       logger.warn(
//         "Worker shutdown already in progress",
//         {
//           signal
//         }
//       );

//       return;
//     }

//     isShuttingDown = true;

//     logger.info(
//       "Worker shutdown started",
//       {
//         signal
//       }
//     );

//     try {
//       // await demoWorker.close();

//       // await closeDemoQueueEvents();

//       // await externalApiWorker.close();

//       await Promise.all([
//       demoWorker.close(),
//       externalApiWorker.close(),
//       closeDemoQueueEvents()
//     ]);

//       logger.info(
//         "Worker shutdown completed"
//       );

//       process.exitCode = 0;
//     } catch (error) {
//       logger.error(
//         "Worker shutdown failed",
//         {
//           error:
//             error instanceof Error
//               ? error.message
//               : String(error)
//         }
//       );

//       process.exitCode = 1;
//     }
//   };

// process.on(
//   "SIGINT",
//   () => {
//     void shutdown("SIGINT");
//   }
// );

// process.on(
//   "SIGTERM",
//   () => {
//     void shutdown("SIGTERM");
//   }
// );

// void start();



import {
  demoWorker
} from "./workers/demo.worker.js";

import {
  startDemoQueueEvents,
  closeDemoQueueEvents
} from "./queues/demo.queue-events.js";

import {
  logger
} from "./logging/logger.js";

import {
  externalApiWorker
} from "./workers/external-api.worker.js";

let isShuttingDown = false;

const start = async (): Promise<void> => {
  try {
    await startDemoQueueEvents();

    await demoWorker.waitUntilReady();

    await externalApiWorker.waitUntilReady();

    logger.info("Worker process started");
  } catch (error) {
    logger.error("Worker process startup failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });

    await Promise.allSettled([
      demoWorker.close(),
      externalApiWorker.close(),
      closeDemoQueueEvents()
    ]);

    process.exitCode = 1;
  }
};

const shutdown = async (
  signal: string
): Promise<void> => {
  if (isShuttingDown) {
    logger.warn("Worker shutdown already in progress", {
      signal
    });

    return;
  }

  isShuttingDown = true;

  logger.info("Worker shutdown started", {
    signal
  });

  try {
    await Promise.all([
      demoWorker.close(),
      externalApiWorker.close(),
      closeDemoQueueEvents()
    ]);

    logger.info("Worker shutdown completed");

    process.exitCode = 0;
  } catch (error) {
    logger.error("Worker shutdown failed", {
      error: error instanceof Error
        ? error.message
        : String(error)
    });

    process.exitCode = 1;
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start();
