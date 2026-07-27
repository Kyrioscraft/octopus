import { Hono } from "hono";
import { cors } from "hono/cors";
import { getLogger, getLogContext } from "@octopus/core";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { configRouter } from "./routes/config.js";
import { workspaceRouter } from "./routes/workspace.js";
import { initDb, listUsers, createUser } from "./db/index.js";
import { hashPassword } from "./auth/password.js";
import { v4 as uuid } from "uuid";
import { requestIdMiddleware, accessLogMiddleware } from "./middleware/logging.js";

// =============================================================================
// createApp — Hono app factory.
// =============================================================================

const logger = getLogger("server.app");

export function createApp(): Hono {
  const app = new Hono();

  // --- Global middleware (order matters: outermost first) ---

  // 1. CORS — allow all origins in dev
  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
  }));

  // 2. Request ID — generates a UUID for every request, injects into logging context
  app.use("*", requestIdMiddleware);

  // 3. Access log — logs every request after it completes
  app.use("*", accessLogMiddleware);

  // --- Auto-init default user (dev convenience — no login required) ---
  app.use("*", async (_c, next) => {
    initDb();
    if (listUsers().length === 0) {
      const id = uuid();
      const hashed = await hashPassword("octopus");
      createUser({
        id,
        username: "octopus",
        hashedPassword: hashed,
        role: "superadmin",
        createdAt: new Date().toISOString(),
      });
      logger.info(`Default user created: octopus / octopus (id: ${id})`);
    }
    await next();
  });

  // --- Routes ---
  app.route("/api/auth", authRouter);
  app.route("/api/chat", chatRouter);
  app.route("/api/config", configRouter);
  app.route("/api/workspace", workspaceRouter);

  // --- Health check ---
  app.get("/api/system/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() })
  );

  // --- Global error handler — catches unhandled errors in any route ---
  app.onError((err, c) => {
    const ctx = getLogContext();
    logger.exception(`Unhandled error: ${c.req.method} ${c.req.path}`, err);

    return c.json(
      {
        error: "internal_server_error",
        message: err.message ?? "Internal server error",
        request_id: ctx?.request_id,
      },
      500,
    );
  });

  return app;
}
