export interface SagaStep<Context> {
  name: string;

  execute(
    context: Context
  ): Promise<void>;

  compensate(
    context: Context
  ): Promise<void>;
}

export type SagaStatus =
  | "completed"
  | "failed"
  | "compensation-failed";

export interface SagaCompensationFailure {
  stepName: string;
  error: unknown;
}

export interface SagaResult {
  status: SagaStatus;
  completedSteps: string[];
  compensatedSteps: string[];
  failedStep: string | null;
  error: unknown | null;
  compensationFailures: SagaCompensationFailure[];
}

export class SagaOrchestrator<Context> {
  constructor(
    private readonly steps: SagaStep<Context>[]
  ) {
    const names = new Set<string>();

    for (const step of steps) {
      if (step.name.trim().length === 0) {
        throw new Error(
          "Saga step name must not be empty"
        );
      }

      if (names.has(step.name)) {
        throw new Error(
          `Duplicate saga step name: ${step.name}`
        );
      }

      names.add(step.name);
    }
  }

  async execute(
    context: Context
  ): Promise<SagaResult> {
    const completed: SagaStep<Context>[] = [];
    const completedSteps: string[] = [];
    const compensatedSteps: string[] = [];
    const compensationFailures:
      SagaCompensationFailure[] = [];

    let failedStep: string | null = null;
    let originalError: unknown | null = null;

    for (const step of this.steps) {
      try {
        await step.execute(context);

        completed.push(step);
        completedSteps.push(step.name);
      } catch (error) {
        failedStep = step.name;
        originalError = error;

        break;
      }
    }

    if (originalError === null) {
      return {
        status: "completed",
        completedSteps,
        compensatedSteps,
        failedStep: null,
        error: null,
        compensationFailures
      };
    }

    for (
      let index = completed.length - 1;
      index >= 0;
      index -= 1
    ) {
      const step = completed[index];

      try {
        await step.compensate(context);

        compensatedSteps.push(step.name);
      } catch (error) {
        compensationFailures.push({
          stepName: step.name,
          error
        });
      }
    }

    return {
      status:
        compensationFailures.length > 0
          ? "compensation-failed"
          : "failed",

      completedSteps,
      compensatedSteps,
      failedStep,
      error: originalError,
      compensationFailures
    };
  }
}