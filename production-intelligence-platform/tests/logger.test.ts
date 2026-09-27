import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach
} from "vitest";

import { logger } from "../src/logging/logger.js";

describe("logger", () => {

  beforeEach(() => {
    vi.spyOn(
      console,
      "log"
    ).mockImplementation(() => {});

    vi.spyOn(
      console,
      "warn"
    ).mockImplementation(() => {});

    vi.spyOn(
      console,
      "error"
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should write a structured info log", () => {

    logger.info(
      "Test message",
      {
        incidentId: "incident-123"
      }
    );

    expect(
      console.log
    ).toHaveBeenCalledTimes(1);

    const call =
      vi.mocked(console.log)
        .mock.calls[0][0];

    const entry =
      JSON.parse(String(call));

    expect(entry.level)
      .toBe("info");

    expect(entry.message)
      .toBe("Test message");

    expect(entry.service)
      .toBe(
        "production-intelligence-platform"
      );

    expect(
      entry.metadata.incidentId
    ).toBe("incident-123");

    expect(entry.timestamp)
      .toBeDefined();
  });

  it("should write errors using console.error", () => {

    logger.error(
      "Something failed",
      {
        incidentId: "incident-123"
      }
    );

    expect(
      console.error
    ).toHaveBeenCalledTimes(1);

    expect(
      console.log
    ).not.toHaveBeenCalled();
  });

});

