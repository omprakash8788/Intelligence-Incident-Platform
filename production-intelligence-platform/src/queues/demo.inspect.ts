import {
  demoQueue
} from "./demo.queue.js";

const counts =
  await demoQueue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed"
  );

console.log(
  counts
);

await demoQueue.close();
