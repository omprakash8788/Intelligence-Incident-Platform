export type ApplicationState =
  | "starting"
  | "ready"
  | "shutting_down"
  | "stopped";


let applicationState: ApplicationState =
  "starting";

export const getApplicationState =
  (): ApplicationState => {
    return applicationState;
  };

export const markApplicationReady =
  (): void => {
    applicationState = "ready";
  };

export const markApplicationShuttingDown =
  (): void => {
    applicationState =
      "shutting_down";
  };

export const markApplicationStopped =
  (): void => {
    applicationState = "stopped";
  };