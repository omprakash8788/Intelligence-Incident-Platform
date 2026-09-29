import {
    describe,
    expect,
    it,
    vi,
    afterEach
} from "vitest";

import type {
    Request,
    Response
} from "express";

import {
    readinessController
} from "../../src/controllers/health.controller.js";

import {
    markApplicationReady
} from "../../src/server/lifecycle.js";

import {
    checkDatabaseConnection
} from "../../src/database/health.js";

vi.mock(
    "../../src/database/health.js",
    () => ({
        checkDatabaseConnection:
            vi.fn()
    })
);

describe(
    "readinessController",
    () => {

        afterEach(() => {
            vi.clearAllMocks();
        });

        it(
            "should return 200 when PostgreSQL is available",
            async () => {

                markApplicationReady();

                vi.mocked(
                    checkDatabaseConnection
                ).mockResolvedValue({
                    "?column?": 1
                });

                const status =
                    vi.fn()
                        .mockReturnThis();

                const json =
                    vi.fn();

                const res = {
                    status,
                    json
                } as unknown as Response;

                await readinessController(
                    {} as Request,
                    res
                );

                expect(status)
                    .toHaveBeenCalledWith(200);

                expect(json)
                    .toHaveBeenCalledWith({
                        status: "ready",
                        state: "ready",
                        dependencies: {
                            postgres: "connected"
                        }
                    });
            }
        );

        it(
            "should return 503 during shutdown",
            async () => {

                const {
                    markApplicationShuttingDown
                } =
                    await import(
                        "../../src/server/lifecycle.js"
                    );

                markApplicationShuttingDown();

                const status =
                    vi.fn()
                        .mockReturnThis();

                const json =
                    vi.fn();

                const res = {
                    status,
                    json
                } as unknown as Response;

                await readinessController(
                    {} as Request,
                    res
                );

                expect(status)
                    .toHaveBeenCalledWith(503);

                expect(json)
                    .toHaveBeenCalledWith({
                        status: "not_ready",
                        state: "shutting_down"
                    });

                expect(
                    checkDatabaseConnection
                ).not.toHaveBeenCalled();
            }
        );

        it(
            "should return 503 when PostgreSQL is unavailable",
            async () => {

                markApplicationReady();

                vi.mocked(
                    checkDatabaseConnection
                ).mockRejectedValue(
                    new Error(
                        "database unavailable"
                    )
                );

                const status =
                    vi.fn()
                        .mockReturnThis();

                const json =
                    vi.fn();

                const res = {
                    status,
                    json
                } as unknown as Response;

                await readinessController(
                    {} as Request,
                    res
                );

                expect(status)
                    .toHaveBeenCalledWith(503);

                expect(json)
                    .toHaveBeenCalledWith({
                        status: "not_ready",
                        state: "ready",
                        dependencies: {
                            postgres: "unavailable"
                        }
                    });
            }
        );
    }
);

