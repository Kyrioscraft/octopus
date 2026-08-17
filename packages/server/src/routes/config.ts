/**
 * Config route — skill/mcp configuration management (thin HTTP adapter).
 *
 * Resource domain: /api/config/skills/* and /api/config/mcp/*. All business
 * logic (file vs user-defined merge, editability rules, disabled state) lives
 * in services/skill.service.ts + services/mcp.service.ts.
 *
 * See ARCHITECTURE_PLAN.md §11.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { getOptionalUser } from "../auth/middleware.js";
import { clearGraphCache } from "@octopus/core";
import type { SubagentEntry } from "@octopus/core";
import {
  listAllSkills,
  getSkillDetail,
  createSkill,
  updateSkill,
  deleteSkill,
  importSkill,
  listBuiltinSkills,
  installBuiltinSkill,
  NotEditableError as SkillNotEditable,
} from "../services/skill.service.js";
import {
  listAllMcp,
  getMcpDetail,
  createMcp,
  updateMcp,
  deleteMcp,
  setMcpEnabled,
  NotEditableError as McpNotEditable,
} from "../services/mcp.service.js";
import {
  listAllSubagents,
  listBuiltinSubagents,
  getSubagentDetail,
  createSubagent,
  updateSubagent,
  deleteSubagent,
  setSubagentEnabled,
  NotEditableError as SubagentNotEditable,
} from "../services/subagent.service.js";
import {
  listModelProviders,
  getModelProviderDetail,
  setDefaultModel,
  updateModelProvider,
  setModelProviderEnabled,
  fetchRemoteModels,
  RemoteFetchError,
  getGeneralSettings,
  updateGeneralSettings,
  getSandboxSettings,
  updateSandboxSettings,
} from "../services/model.service.js";
import {
  listAllCommands,
  getCommand,
  createCommand,
  updateCommand,
  deleteCommand,
} from "../services/slash-command.service.js";

export const configRouter = new Hono();

/** Map a service error to the right HTTP status. Shared helper. */
function handleError(c: Context, err: unknown) {
  if (
    err instanceof SkillNotEditable ||
    err instanceof McpNotEditable ||
    err instanceof SubagentNotEditable
  ) {
    return c.json(
      { error: "not_editable", origin: err.origin, message: (err as Error).message },
      409,
    );
  }
  if (err instanceof RemoteFetchError) {
    // Hono's c.json requires a literal status; clamp to a known-valid set.
    const status: 400 | 404 | 502 =
      err.status === 404 ? 404 : err.status === 502 ? 502 : 400;
    return c.json({ error: "remote_fetch", message: err.message }, status);
  }
  return c.json({ error: "bad_request", message: (err as Error).message }, 400);
}

// =============================================================================
// Skills: /api/config/skills
// =============================================================================

configRouter.get("/skills", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  return c.json({ skills: listAllSkills(userId) });
});

configRouter.get("/skills/:name", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const detail = getSkillDetail(userId, c.req.param("name"));
  if (!detail) return c.json({ detail: "skill 不存在" }, 404);
  return c.json(detail);
});

configRouter.post("/skills", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{ name: string; description: string; content: string }>();
  try {
    const skill = createSkill(userId, body);
    return c.json({ skill }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/skills/:name", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{ description?: string; content?: string }>();
  try {
    const skill = updateSkill(userId, c.req.param("name"), body);
    return c.json({ skill });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.delete("/skills/:name", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  try {
    deleteSkill(userId, c.req.param("name"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

// --- Skill import (multipart .zip / .md upload) ---
configRouter.post("/skills/import", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  let body: Record<string, string | File>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "bad_request", message: "无效的 multipart 请求" }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "bad_request", message: "缺少 file 字段" }, 400);
  }
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const skill = importSkill(userId, file.name || "upload.md", buf);
    return c.json({ skill }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

// --- Builtin skill catalog ---
configRouter.get("/skills/builtin", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  return c.json({ skills: listBuiltinSkills(userId) });
});

configRouter.post("/skills/:name/install", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  try {
    const skill = installBuiltinSkill(userId, c.req.param("name"));
    return c.json({ skill }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

// =============================================================================
// MCP: /api/config/mcp
// =============================================================================

configRouter.get("/mcp", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const probe = c.req.query("probe") === "true";
  return c.json({ servers: listAllMcp(userId, probe) });
});

configRouter.get("/mcp/:name", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const server = getMcpDetail(userId, c.req.param("name"));
  if (!server) return c.json({ detail: "MCP server 不存在" }, 404);
  return c.json(server);
});

configRouter.post("/mcp", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    name: string;
    transport?: "stdio" | "sse" | "http" | "streamable-http";
    config: Record<string, unknown>;
  }>();
  try {
    const server = createMcp(userId, body);
    return c.json({ server }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/mcp/:name", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    transport?: "stdio" | "sse" | "http" | "streamable-http";
    config?: Record<string, unknown>;
  }>();
  try {
    const server = updateMcp(userId, c.req.param("name"), body);
    return c.json({ server });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.delete("/mcp/:name", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  try {
    deleteMcp(userId, c.req.param("name"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/mcp/:name/enabled", getOptionalUser, async (c) => {
  const name = c.req.param("name");
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  setMcpEnabled(name, enabled === true);
  return c.json({ success: true, enabled: enabled === true });
});

// =============================================================================
// Subagents: /api/config/subagents
// =============================================================================

/**
 * Map a built-in subagent descriptor (from core's BUILTIN_SUBAGENTS) to the
 * read-only SubagentEntry shape used by the API. Built-ins are always enabled
 * and never editable; a user/file entry of the same name shadows them.
 * `model` reflects the user's per-user override (if any).
 */
function builtInSubagentEntry(b: SubagentEntry): SubagentEntry {
  return {
    ...b,
    origin: "builtin",
    editable: false,
    enabled: true,
    source: "builtin",
  };
}

configRouter.get("/subagents", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const userEntries = listAllSubagents(userId);
  const userNames = new Set(userEntries.map((s) => s.name));
  // Prepend built-in subagents (Explore, general-purpose) as read-only
  // entries (with the user's model overrides applied). A user/file entry
  // with the same name takes precedence (shadowing the built-in) — matching
  // core's registry behavior.
  const builtinEntries = listBuiltinSubagents(userId)
    .filter((b) => !userNames.has(b.name))
    .map(builtInSubagentEntry);
  return c.json({ subagents: [...builtinEntries, ...userEntries] });
});

configRouter.get("/subagents/:name", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const name = c.req.param("name");
  // user/file entries shadow built-ins (same precedence as the list endpoint
  // and core's registry), so check them first.
  const subagent = getSubagentDetail(userId, name);
  if (subagent) return c.json(subagent);
  return c.json({ detail: "子智能体不存在" }, 404);
});

configRouter.post("/subagents", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[];
    model?: string | null;
  }>();
  try {
    const subagent = createSubagent(userId, body);
    clearGraphCache();
    return c.json({ subagent }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/subagents/:name", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    description?: string;
    systemPrompt?: string;
    tools?: string[];
    model?: string | null;
  }>();
  try {
    const subagent = updateSubagent(userId, c.req.param("name"), body);
    // Model/shape changes affect graph compilation — drop stale graphs.
    clearGraphCache();
    return c.json({ subagent });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.delete("/subagents/:name", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  try {
    deleteSubagent(userId, c.req.param("name"));
    clearGraphCache();
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/subagents/:name/enabled", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  try {
    const result = setSubagentEnabled(userId, c.req.param("name"), enabled === true);
    clearGraphCache();
    return c.json({ success: true, enabled: result });
  } catch (err) {
    return handleError(c, err);
  }
});

// =============================================================================
// Models: /api/config/models
// =============================================================================

configRouter.get("/models", getOptionalUser, (c) => {
  return c.json(listModelProviders());
});

configRouter.get("/models/:name", getOptionalUser, (c) => {
  const detail = getModelProviderDetail(c.req.param("name"));
  if (!detail) return c.json({ detail: "模型供应商不存在" }, 404);
  return c.json(detail);
});

configRouter.put("/models/default", getOptionalUser, async (c) => {
  const { default_model } = await c.req.json<{ default_model: string }>();
  try {
    return c.json(setDefaultModel(default_model));
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/models/:name", getOptionalUser, async (c) => {
  const body = await c.req.json<{
    enabled?: boolean;
    apiKey?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    models?: string[];
    displayName?: string;
    apiType?: string;
    /** New provider key (rename). */
    newName?: string;
  }>();
  try {
    const provider = updateModelProvider(c.req.param("name"), body);
    return c.json({ provider });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/models/:name/enabled", getOptionalUser, async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  try {
    return c.json(setModelProviderEnabled(c.req.param("name"), enabled === true));
  } catch (err) {
    return handleError(c, err);
  }
});

// Fetch a provider's live model list (no persistence). Probes the upstream
// /models (or /api/tags for Ollama) endpoint using resolved credentials.
configRouter.get("/models/:name/remote", getOptionalUser, async (c) => {
  try {
    const models = await fetchRemoteModels(c.req.param("name"));
    return c.json({ models });
  } catch (err) {
    return handleError(c, err);
  }
});

// =============================================================================
// General settings: /api/config/settings
// =============================================================================

configRouter.get("/settings", getOptionalUser, (c) => {
  return c.json(getGeneralSettings());
});

configRouter.put("/settings", getOptionalUser, async (c) => {
  const body = await c.req.json<{
    enableShell?: boolean;
    enableWebSearch?: boolean;
    interactive?: boolean;
    autoApprove?: boolean;
  }>();
  try {
    return c.json(updateGeneralSettings(body));
  } catch (err) {
    return handleError(c, err);
  }
});

// =============================================================================
// Sandbox settings: /api/config/sandbox
// =============================================================================

configRouter.get("/sandbox", getOptionalUser, (c) => {
  return c.json(getSandboxSettings());
});

configRouter.put("/sandbox", getOptionalUser, async (c) => {
  const body = await c.req.json<{
    enabled?: boolean;
    provider?: "langsmith";
    apiKey?: string;
    apiKeyEnv?: string | null;
    templateName?: string | null;
    snapshotId?: string | null;
  }>();
  try {
    return c.json(updateSandboxSettings(body));
  } catch (err) {
    return handleError(c, err);
  }
});

// =============================================================================
// Slash commands: /api/config/slash-commands
// =============================================================================

configRouter.get("/slash-commands", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const platform = c.req.query("platform") as
    | "web"
    | "tui"
    | "all"
    | undefined;
  return c.json({ commands: listAllCommands(userId, platform) });
});

configRouter.get("/slash-commands/:id", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  const cmd = getCommand(userId, c.req.param("id"));
  if (!cmd) return c.json({ detail: "命令不存在" }, 404);
  return c.json(cmd);
});

configRouter.post("/slash-commands", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    name: string;
    displayName: string;
    description: string;
    icon?: string | null;
    promptTemplate: string;
    action?: "insert" | "send";
    category?: string | null;
  }>();
  try {
    const command = createCommand(userId, body);
    return c.json({ command }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.put("/slash-commands/:id", getOptionalUser, async (c) => {
  const userId = c.var.user.sub;
  const body = await c.req.json<{
    name?: string;
    displayName?: string;
    description?: string;
    icon?: string | null;
    promptTemplate?: string;
    action?: "insert" | "send";
    category?: string | null;
  }>();
  try {
    const command = updateCommand(userId, c.req.param("id"), body);
    return c.json({ command });
  } catch (err) {
    return handleError(c, err);
  }
});

configRouter.delete("/slash-commands/:id", getOptionalUser, (c) => {
  const userId = c.var.user.sub;
  try {
    deleteCommand(userId, c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});
