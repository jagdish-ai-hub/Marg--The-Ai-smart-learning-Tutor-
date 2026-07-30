/**
 * @file Lets route handlers use `async`/`await` safely.
 *
 * THE PROBLEM THIS SOLVES
 * Express 4 does not understand promises. If an `async` route handler throws,
 * Express never sees the error — the request just hangs until it times out,
 * with nothing in the logs. It is a genuinely confusing bug the first time you
 * hit it.
 *
 * Wrapping the handler catches the rejected promise and forwards it to
 * `next()`, which is what the error middleware listens to.
 *
 * @example
 * // Without this, a thrown error would hang the request:
 * router.get('/sessions', asyncHandler(async (req, res) => {
 *   const sessions = await sessionService.list(req.user.id);
 *   res.ok({ sessions });
 * }));
 */

/**
 * Wraps an async Express handler so rejected promises reach the error middleware.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} handler
 *   Your async route handler.
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => void}
 *   A plain handler Express can use.
 */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
