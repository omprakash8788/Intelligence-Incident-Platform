import type {
    JobState
} from "bullmq";

import {
    demoQueue
} from "../queues/demo.queue.js";

export interface DemoJobStatus {
    id: string;
    name: string;
    state: JobState | unknown;
    data: unknown;
    result: unknown;
    attemptsMade: number;
    attemptsAllowed: number;
    failedReason: string | undefined;
    delay: number;
    timestamp: number;
    processedOn: number | undefined;
    finishedOn: number | undefined;
}

export const getDemoJobStatus =
    async (
        jobId: string
    ): Promise<
        DemoJobStatus | null
    > => {

        const job =
            await demoQueue.getJob(
                jobId
            );

        if (!job) {
            return null;
        }

        const state =
            await job.getState();

        return {
            id:
                job.id ?? jobId,

            name:
                job.name,

            state,

            data:
                job.data,

            result:
                job.returnvalue,

            attemptsMade:
                job.attemptsMade,

            attemptsAllowed:
                job.opts.attempts ?? 1,

            failedReason:
                job.failedReason,
            delay: job.delay,
            timestamp: job.timestamp,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn
        };
    };