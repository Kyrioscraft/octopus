/**
 * Workspace route — thin HTTP adapter over workspace.service.
 *
 * Resource domain: /api/workspace/*. Two flavors of routes share this router:
 *   1. workspace CRUD:          /api/workspace, /api/workspace/:id
 *   2. workspace file ops:      /api/workspace/:id/tree|file|directory|download|upload
 *
 * All business logic (DB + disk + preview detection + traversal protection)
 * lives in services/workspace.service.ts. See ARCHITECTURE: 工作区设计.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { getOptionalUser } from "../auth/middleware.js";
import {
  NotFoundError,
  NotEditableError,
  PathTraversalError,
  createDirectory,
  createWorkspace,
  deletePath,
  deleteWorkspace,
  downloadFile,
  getWorkspaceDetail,
  listAllWorkspaces,
  listHostDirs,
  listTree,
  openOrCreateWorkspace,
  readFile,
  updateWorkspaceMeta,
  uploadFile,
  writeFile,
} from "../services/workspace.service.js";
import type { WorkspaceCreateInput, WorkspaceUpdateInput } from "../services/workspace.service.js";

export const workspaceRouter = new Hono();

/** Map a service error to the right HTTP status. */
function handleError(c: Context, err: unknown) {
  if (err instanceof NotFoundError) {
    return c.json({ error: "not_found", message: err.message }, 404);
  }
  if (err instanceof PathTraversalError) {
    return c.json({ error: "path_traversal", message: (err as Error).message }, 400);
  }
  if (err instanceof NotEditableError) {
    return c.json(
      { error: "not_editable", origin: err.origin, message: err.message },
      409,
    );
  }
  return c.json({ error: "bad_request", message: (err as Error).message }, 400);
}

// =============================================================================
// Workspace CRUD
// =============================================================================

workspaceRouter.get("/", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  return c.json({ workspaces: listAllWorkspaces(userId) });
});

workspaceRouter.post("/", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    name: string;
    description?: string;
    environment?: "local" | "sandbox";
    /** Optional absolute host path to bind (local only). */
    path?: string;
  }>();
  try {
    const ws = createWorkspace(userId, body as WorkspaceCreateInput);
    return c.json({ workspace: ws }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

/** Browse host directories for the "本机目录" picker (root-constrained). */
workspaceRouter.get("/browse", getOptionalUser, (c) => {
  const path = c.req.query("path") || undefined;
  try {
    return c.json(listHostDirs(path));
  } catch (err) {
    return handleError(c, err);
  }
});

/** Open (or reopen) a host directory as a workspace — IDE "Open Folder". */
workspaceRouter.post("/open", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const { path } = await c.req.json<{ path: string }>();
  if (!path || !path.trim()) {
    return c.json({ error: "bad_request", message: "缺少 path 字段" }, 400);
  }
  try {
    const ws = openOrCreateWorkspace(userId, path);
    return c.json({ workspace: ws }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

workspaceRouter.get("/:id", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const ws = getWorkspaceDetail(userId, c.req.param("id"));
  if (!ws) return c.json({ error: "not_found", message: "工作区不存在" }, 404);
  return c.json({ workspace: ws });
});

workspaceRouter.put("/:id", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{ name?: string; description?: string | null }>();
  try {
    const ws = updateWorkspaceMeta(userId, c.req.param("id"), body as WorkspaceUpdateInput);
    if (!ws) return c.json({ error: "not_found", message: "工作区不存在" }, 404);
    return c.json({ workspace: ws });
  } catch (err) {
    return handleError(c, err);
  }
});

workspaceRouter.delete("/:id", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  try {
    deleteWorkspace(userId, c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

// =============================================================================
// File operations within a workspace
// =============================================================================

workspaceRouter.get("/:id/tree", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const rel = c.req.query("path") || undefined;
  const recursive = c.req.query("recursive") === "true";
  try {
    const entries = listTree(userId, c.req.param("id"), rel, recursive);
    return c.json({ entries });
  } catch (err) {
    return handleError(c, err);
  }
});

workspaceRouter.get("/:id/file", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const rel = c.req.query("path") || "";
  try {
    const result = readFile(userId, c.req.param("id"), rel);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

workspaceRouter.put("/:id/file", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{ path: string; content: string }>();
  try {
    const result = writeFile(userId, c.req.param("id"), body.path, body.content);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

workspaceRouter.delete("/:id/file", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const rel = c.req.query("path") || "";
  try {
    const result = deletePath(userId, c.req.param("id"), rel);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

workspaceRouter.post("/:id/directory", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{ parentPath?: string; name: string }>();
  try {
    const result = createDirectory(userId, c.req.param("id"), body.parentPath, body.name);
    return c.json(result, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

/** Streaming download — used by image/pdf preview on the client. */
workspaceRouter.get("/:id/download", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const rel = c.req.query("path") || "";
  try {
    const dl = downloadFile(userId, c.req.param("id"), rel);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(dl.size));
    c.header(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(dl.name)}"`,
    );
    return stream(c, async (ws) => {
      const reader = dl.stream;
      // Pipe a Node readable into Hono's stream writer.
      for await (const chunk of reader as unknown as AsyncIterable<Buffer>) {
        await ws.write(chunk);
      }
    });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Multipart upload (single file). 100 MB cap. */
workspaceRouter.post("/:id/upload", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const MAX = 100 * 1024 * 1024;
  let body: Record<string, string | File>;
  try {
    body = await c.req.parseBody({ all: false });
  } catch {
    return c.json({ error: "bad_request", message: "无效的 multipart 请求" }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "bad_request", message: "缺少 file 字段" }, 400);
  }
  const parentPath = typeof body["parentPath"] === "string" ? body["parentPath"] : undefined;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength > MAX) {
      return c.json({ error: "too_large", message: "文件超过 100MB 限制" }, 413);
    }
    const result = uploadFile(userId, c.req.param("id"), parentPath, file.name || "upload", buf);
    return c.json(result, 201);
  } catch (err) {
    return handleError(c, err);
  }
});
