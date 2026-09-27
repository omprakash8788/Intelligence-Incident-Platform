import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const requestContextStorage =
  new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(
  context: RequestContext,
  callback: () => T
): T => {
  return requestContextStorage.run(
    context,
    callback
  );
};

export const getRequestContext =
  (): RequestContext | undefined => {
    return requestContextStorage.getStore();
  };

export const getRequestId =
  (): string | undefined => {
    return getRequestContext()?.requestId;
  };

