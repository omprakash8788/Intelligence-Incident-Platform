// import { createServer } from "node:http";

// import app from "./app.js";
// import { env } from "./config/env.js";
// import { logger } from "./logging/logger.js";
// import { shutdown } from "./server/shutdown.js";
// import {
//   markApplicationReady
// } from "./server/lifecycle.js";



// import {
//   connectRedis
// } from "./redis/lifecycle.js";


// const server =
//   createServer(app);


// const start =
//   async (): Promise<void> => {
//     try {
//       await connectRedis();

//       server.listen(
//         env.app.port,
//         () => {
//           markApplicationReady();

//           logger.info(
//             "Server started",
//             {
//               port:
//                 env.app.port,

//               environment:
//                 env.app.nodeEnv
//             }
//           );
//         }
//       );
//     } catch (error) {
//       logger.error(
//         "Application startup failed",
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

// const handleShutdown =
//   (signal: string) => {
//     void shutdown(
//       server,
//       signal
//     );
//   };

// process.on(
//   "SIGINT",
//   () => {
//     handleShutdown("SIGINT");
//   }
// );

// process.on(
//   "SIGTERM",
//   () => {
//     handleShutdown("SIGTERM");
//   }
// );

// void start();


// // const server =
// //   app.listen(
// //     env.app.port,
// //     () => {
// //        markApplicationReady();
// //       logger.info(
// //         "Server started",
// //         {
// //           port: env.app.port,
// //           environment:
// //             env.app.nodeEnv
// //         }
// //       );
// //     }
// //   );

// // process.on(
// //   "SIGINT",
// //   () => {
// //     void shutdown(
// //       server,
// //       "SIGINT"
// //     );
// //   }
// // );

// // process.on(
// //   "SIGTERM",
// //   () => {
// //     void shutdown(
// //       server,
// //       "SIGTERM"
// //     );
// //   }
// // );


import { createServer } from "node:http";

import app from "./app.js";

import { env } from "./config/env.js";

import { logger } from "./logging/logger.js";

import {
  markApplicationReady
} from "./server/lifecycle.js";

import {
  shutdown
} from "./server/shutdown.js";

import {
  connectRedis
} from "./redis/lifecycle.js";

const server =
  createServer(app);

const start =
  async (): Promise<void> => {
    try {
      await connectRedis();

      server.listen(
        env.app.port,
        () => {
          markApplicationReady();

          logger.info(
            "Server started",
            {
              port:
                env.app.port,

              environment:
                env.app.nodeEnv
            }
          );
        }
      );
    } catch (error) {
      logger.error(
        "Application startup failed",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );

      process.exitCode = 1;
    }
  };

const handleShutdown =
  (signal: string) => {
    void shutdown(
      server,
      signal
    );
  };

process.on(
  "SIGINT",
  () => {
    handleShutdown("SIGINT");
  }
);

process.on(
  "SIGTERM",
  () => {
    handleShutdown("SIGTERM");
  }
);

void start();