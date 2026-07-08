import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import {
  initDb,
  listUsers,
  getUserByUsername,
  getUserById,
  createUser,
} from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signToken } from "../auth/jwt.js";
import { getCurrentUser } from "../auth/middleware.js";

export const authRouter = new Hono();

// =============================================================================
// Schemas
// =============================================================================

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const initSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(6).max(128),
});

// =============================================================================
// GET /api/auth/check-first-run
// =============================================================================

authRouter.get("/check-first-run", (c) => {
  return c.json({ isFirstRun: listUsers().length === 0 });
});

// =============================================================================
// POST /api/auth/initialize
// =============================================================================

authRouter.post("/initialize", zValidator("json", initSchema), async (c) => {
  const body = c.req.valid("json");

  // Only allow when no users exist
  if (listUsers().length > 0) {
    return c.json({ detail: "已初始化，请使用登录接口" }, 400);
  }

  const id = uuid();
  const hashed = await hashPassword(body.password);

  createUser({
    id,
    username: body.username,
    hashedPassword: hashed,
    role: "superadmin",
    createdAt: new Date().toISOString(),
  });

  const token = await signToken({ sub: id, role: "superadmin" });

  return c.json({
    success: true,
    user: { id, username: body.username, role: "superadmin" },
    access_token: token,
    token_type: "bearer",
  });
});

// =============================================================================
// POST /api/auth/login
// =============================================================================

authRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  const body = c.req.valid("json");

  const row = getUserByUsername(body.username);
  if (!row) {
    return c.json({ detail: "用户名或密码错误" }, 401);
  }

  const valid = await verifyPassword(body.password, row.hashedPassword);
  if (!valid) {
    return c.json({ detail: "用户名或密码错误" }, 401);
  }

  const token = await signToken({ sub: row.id, role: row.role });

  return c.json({
    success: true,
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.createdAt,
    },
    access_token: token,
    token_type: "bearer",
  });
});

// =============================================================================
// GET /api/auth/me — get current user info
// =============================================================================

authRouter.get("/me", getCurrentUser, (c) => {
  const payload = c.var.user;
  const row = getUserById(payload.sub);

  return c.json({
    id: row?.id ?? payload.sub,
    username: row?.username ?? "",
    role: row?.role ?? payload.role,
  });
});
