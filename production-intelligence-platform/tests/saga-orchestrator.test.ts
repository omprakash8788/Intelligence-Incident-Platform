import {
  describe,
  expect,
  it,
  vi
} from "vitest";

import {
  SagaOrchestrator,
  type SagaStep
} from "../src/services/saga-orchestrator.js";

interface OrderContext {
  orderId: string;
  events: string[];
}

const createContext = (): OrderContext => ({
  orderId: "order-100",
  events: []
});

describe("SagaOrchestrator", () => {
  it("executes every step when all steps succeed", async () => {
    const context = createContext();

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async (ctx) => {
          ctx.events.push("reserve");
        },

        compensate: async (ctx) => {
          ctx.events.push("release");
        }
      },
      {
        name: "charge-customer",

        execute: async (ctx) => {
          ctx.events.push("charge");
        },

        compensate: async (ctx) => {
          ctx.events.push("refund");
        }
      },
      {
        name: "arrange-shipment",

        execute: async (ctx) => {
          ctx.events.push("ship");
        },

        compensate: async (ctx) => {
          ctx.events.push("cancel-shipment");
        }
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe("completed");

    expect(result.completedSteps).toEqual([
      "reserve-inventory",
      "charge-customer",
      "arrange-shipment"
    ]);

    expect(result.compensatedSteps).toEqual([]);
    expect(result.failedStep).toBeNull();
    expect(result.error).toBeNull();

    expect(context.events).toEqual([
      "reserve",
      "charge",
      "ship"
    ]);
  });

  it("compensates completed steps in reverse order", async () => {
    const context = createContext();

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async (ctx) => {
          ctx.events.push("reserve");
        },

        compensate: async (ctx) => {
          ctx.events.push("release");
        }
      },
      {
        name: "charge-customer",

        execute: async (ctx) => {
          ctx.events.push("charge");
        },

        compensate: async (ctx) => {
          ctx.events.push("refund");
        }
      },
      {
        name: "arrange-shipment",

        execute: async () => {
          throw new Error(
            "Shipment service unavailable"
          );
        },

        compensate: async (ctx) => {
          ctx.events.push("cancel-shipment");
        }
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe("failed");

    expect(result.completedSteps).toEqual([
      "reserve-inventory",
      "charge-customer"
    ]);

    expect(result.compensatedSteps).toEqual([
      "charge-customer",
      "reserve-inventory"
    ]);

    expect(result.failedStep).toBe(
      "arrange-shipment"
    );

    expect(result.error).toEqual(
      new Error("Shipment service unavailable")
    );

    expect(context.events).toEqual([
      "reserve",
      "charge",
      "refund",
      "release"
    ]);
  });

  it("continues compensating if one compensation fails", async () => {
    const context = createContext();

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async (ctx) => {
          ctx.events.push("reserve");
        },

        compensate: async (ctx) => {
          ctx.events.push("release");
        }
      },
      {
        name: "charge-customer",

        execute: async (ctx) => {
          ctx.events.push("charge");
        },

        compensate: async () => {
          throw new Error("Refund service unavailable");
        }
      },
      {
        name: "arrange-shipment",

        execute: async () => {
          throw new Error("Shipment failed");
        },

        compensate: async () => {}
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe(
      "compensation-failed"
    );

    expect(result.compensatedSteps).toEqual([
      "reserve-inventory"
    ]);

    expect(result.compensationFailures).toHaveLength(1);

    expect(
      result.compensationFailures[0].stepName
    ).toBe("charge-customer");

    expect(context.events).toEqual([
      "reserve",
      "charge",
      "release"
    ]);
  });

  it("does not execute later steps after a failure", async () => {
    const context = createContext();

    const laterExecute = vi.fn(
      async () => undefined
    );

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async () => {
          throw new Error("Inventory unavailable");
        },

        compensate: async () => {}
      },
      {
        name: "charge-customer",

        execute: laterExecute,

        compensate: async () => {}
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(context);

    expect(result.status).toBe("failed");

    expect(result.completedSteps).toEqual([]);

    expect(result.compensatedSteps).toEqual([]);

    expect(result.failedStep).toBe(
      "reserve-inventory"
    );

    expect(laterExecute).not.toHaveBeenCalled();
  });

  it("rejects duplicate step names", () => {
    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve",

        execute: async () => {},

        compensate: async () => {}
      },
      {
        name: "reserve",

        execute: async () => {},

        compensate: async () => {}
      }
    ];

    expect(() => {
      new SagaOrchestrator(steps);
    }).toThrow("Duplicate saga step name: reserve");
  });

  it("rejects an empty step name", () => {
    const steps: SagaStep<OrderContext>[] = [
      {
        name: " ",

        execute: async () => {},

        compensate: async () => {}
      }
    ];

    expect(() => {
      new SagaOrchestrator(steps);
    }).toThrow("Saga step name must not be empty");
  });

  it("does not compensate a step whose execution failed", async () => {
    const compensate = vi.fn(
      async () => undefined
    );

    const steps: SagaStep<OrderContext>[] = [
      {
        name: "reserve-inventory",

        execute: async () => {
          throw new Error("Reservation failed");
        },

        compensate
      }
    ];

    const saga = new SagaOrchestrator(steps);

    const result = await saga.execute(
      createContext()
    );

    expect(result.status).toBe("failed");

    expect(compensate).not.toHaveBeenCalled();
  });
});