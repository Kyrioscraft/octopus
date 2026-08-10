import { createMiddleware } from "hono/factory";
import { verifyToken, type TokenPayload } from "./jwt.js";

// =============================================================================
// Auth middleware — extracts JWT from Authorization header.
// =============================================================================

export interface AuthedContext {
  Variables: {
    user: TokenPayload;
  };
}

/**
 * Extract and verify the JWT from the Authorization header.
 *
 * Sets `c.var.user` with the decoded payload on success.
 * Returns 401 if the header is missing or the token is invalid.
 */
export const getCurrentUser = createMiddleware<AuthedContext>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ detail: "未登录或 Token 已过期" }, 401);
  }

  try {
    const payload = await verifyToken(header.slice(7));
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ detail: "Token 无效或已过期" }, 401);
  }
});

/**
 * Extract and verify JWT. If no token or invalid, use a default dev user.
 *
 * This allows the frontend to work without a login page during Phase 2
 * development. Set `JWT_SECRET_KEY` in production to enable real auth.
 */
export const getOptionalUser = createMiddleware<AuthedContext>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = await verifyToken(header.slice(7));
      c.set("user", payload);
      await next();
      return;
    } catch { /* fall through to default user */ }
  }
  // Default dev user
  c.set("user", { sub: "dev-user", role: "superadmin" });
  await next();
});
