import {
  describe,
  expect,
  it,
  beforeEach
} from "vitest";

import {
  getApplicationState,
  markApplicationReady,
  markApplicationShuttingDown,
  markApplicationStopped
} from "../../src/server/lifecycle.js";

describe(
  "application lifecycle",
  () => {

    beforeEach(() => {
      markApplicationReady();
    });

    it(
      "should start in a ready state for tests",
      () => {

        expect(
          getApplicationState()
        ).toBe("ready");
      }
    );

    it(
      "should transition to shutting_down",
      () => {

        markApplicationShuttingDown();

        expect(
          getApplicationState()
        ).toBe("shutting_down");
      }
    );

    it(
      "should transition to stopped",
      () => {

        markApplicationStopped();

        expect(
          getApplicationState()
        ).toBe("stopped");
      }
    );
  }
);

