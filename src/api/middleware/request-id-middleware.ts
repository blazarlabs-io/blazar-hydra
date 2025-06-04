import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Constant
export const REQUEST_ID_HEADER = 'x-request-id';
export function generateRequestId() {
  return randomUUID();
}

// Context
let currentContext: AsyncLocalStorage<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function context<T = any>(): AsyncLocalStorage<T> {
  if (currentContext === undefined) {
    currentContext = new AsyncLocalStorage<T>();
  }
  return currentContext as AsyncLocalStorage<T>;
}

/**
 * This is an express middleware that:
 * - Generate/Use request id (depending on if you already have one in the request header)
 * - Add it to the request context
 *
 * **Important:** this should be your first middleware
 */
export function addRequestId(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
) {
  let requestId = req.headers[REQUEST_ID_HEADER];

  if (!requestId) {
    requestId = generateRequestId();
    req.headers[REQUEST_ID_HEADER] = requestId;
  }

  res.setHeader(REQUEST_ID_HEADER, requestId);

  const currentContext = context().getStore();

  if (currentContext) {
    // Append to the current context
    currentContext.requestId = requestId;
    next();
    return;
  }

  context().run({ requestId }, next);
}

export { context, addRequestId as addRequestIdExpressMiddleware };
