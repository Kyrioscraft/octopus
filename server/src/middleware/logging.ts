/**
 * Logging middleware for the Hono HTTP server.
 *
 * Two middlewares:
 *   `requestIdMiddleware` — generates a UUID per request and injects
 *     `{ request_id, user_id }` into the logging context via AsyncLocalStorage.
 *     All log calls inside the request handler will carry these tags.
 *
 *   `accessLogMiddleware` — logs METHOD /path → STATUS (XXms) after each
 *     request, similar to Python's `AccessLogMiddleware` / Apache combined log.
 */

import type { MiddlewareHandler } from "hono";
import { v4 as uuidv4 } from "uuid";
import { getLogger, withContext, type LogContext } from "@octopus/core";

const accessLogger = getLogger("access");

// =============================================================================
// requestIdMiddleware — inject request_id into logging context.
// =============================================================================

/**
 * Middleware that generates a `request_id` (UUID) for every request and
 * injects it into the AsyncLocalStorage logging context.
 *
 * The `request_id` is also stored on `c.set("request_id", ...)` so
 * route handlers can read it for stamping onto NDJSON streaming chunks.
 */
export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = uuidv4().slice(0, 8); // short 8-char ID for readability

  const ctx: LogContext = { request_id: requestId };

  // Try to extract user_id from Authorization header (optional)
  try {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      // Simple extraction — full JWT decode is done by auth middleware later.
      // We just note the presence of a token for correlation.
      ctx.user_id = "authenticated";
    }
  } catch {
    // Ignore — user_id is best-effort
  }

  // Store in Hono context so route handlers can access it
  c.set("logContext", ctx);
  c.set("request_id", requestId);

  // Run the rest of the request chain inside the logging context
  return withContext(ctx, async () => {
    await next();
  });
};

// =============================================================================
// accessLogMiddleware — log every request in Apache-combined style.
// =============================================================================

/**
 * Middleware that logs every HTTP request after it completes.
 *
 * Format: `127.0.0.1 - POST /api/chat/agent → 200 (1234ms)`
 *
 * The `request_id` is automatically appended by the logging system
 * when running inside `requestIdMiddleware`'s AsyncLocalStorage context.
 */
export const accessLogMiddleware: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;
  const query = c.req.query();
  const queryStr = Object.keys(query).length > 0
    ? "?" + new URLSearchParams(query as Record<string, string>).toString()
    : "";

  // Client IP (X-Forwarded-For aware)
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "127.0.0.1";

  await next();

  const duration = Math.round(performance.now() - start);
  const status = c.res.status;

  accessLogger.info(
    `${ip} - ${method} ${path}${queryStr} → ${status} (${duration}ms)`,
  );
};
