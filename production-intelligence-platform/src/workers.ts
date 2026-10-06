import {
  demoWorker
} from "./workers/demo.worker.js";

console.log(
  "Worker process started"
);

const shutdown =
  async (
    signal: string
  ): Promise<void> => {

    console.log(
      `Worker shutdown started: ${signal}`
    );

    await demoWorker.close();

    console.log(
      "Worker shutdown completed"
    );
  };

process.on(
  "SIGINT",
  () => {
    void shutdown("SIGINT");
  }
);

process.on(
  "SIGTERM",
  () => {
    void shutdown("SIGTERM");
  }
);

