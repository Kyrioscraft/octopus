import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// =============================================================================
// Drizzle schema for the SQLite store.
//
// Column names are snake_case at the DB layer; Drizzle maps them to camelCase
// TypeScript properties automatically. JSON-shaped fields (toolCalls, feedback,
// extraMetadata) are stored as TEXT and serialized/deserialized in db/index.ts.
// =============================================================================

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  role: text("role").notNull(),
  createdAt: text("created_at").notNull(),
});

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  agentId: text("agent_id").notNull(),
  // Optional workspace binding. Nullable so existing threads (created before
  // workspaces) keep working. Backfilled lazily via getOrCreateDefaultWorkspace.
  // NOTE: kept out of the DDL initially and added via idempotent ALTER TABLE
  // (see db/index.ts) so pre-existing SQLite files upgrade in place.
  workspaceId: text("workspace_id"),
  createdAt: text("created_at").notNull(),
});

// =============================================================================
// Workspaces — filesystem-backed, DB-tracked (see ARCHITECTURE: 工作区设计).
//
// A workspace is a per-user directory on disk (data/workspaces/<userId>/<id>)
// whose `path` column records the absolute host path. Threads belong to a
// workspace (1:N); the agent's working directory is set to the workspace path
// so file tool calls land inside it. Files themselves are NOT stored as rows —
// the directory tree IS the file tree.
// =============================================================================

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // Absolute host filesystem path of the workspace directory.
    path: text("path").notNull(),
    // Environment: "local" = host filesystem dir the agent chdir's into;
    // "sandbox" = a (future) isolated container. Sandbox is a model/UI
    // placeholder this iteration — no real backend yet.
    environment: text("environment").notNull().default("local"),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // Timestamp of the last time the user opened this workspace (recents list).
    lastOpenedAt: text("last_opened_at"),
  },
  (t) => ({
    uniq: uniqueIndex("ws_user_name").on(t.userId, t.name),
  }),
);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  // ON DELETE CASCADE — when a thread is deleted, its messages go with it.
  // Requires `PRAGMA foreign_keys = ON` (set at connection time in db/index.ts).
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: text("tool_calls"),
  feedback: text("feedback"),
  extraMetadata: text("extra_metadata"),
  createdAt: text("created_at").notNull(),
});

// =============================================================================
// User-defined skill/mcp configuration (Phase F — see ARCHITECTURE_PLAN §11).
//
// These store configs created via the web/tui UI (origin="user-defined").
// File-source skills/mcp (.mcp.json, SKILL.md) are NOT stored here — they are
// discovered read-only from the filesystem at list time. The two sources are
// merged in the service layer using core's mergeSkillEntries/mergeMcpEntries.
// =============================================================================

export const userSkills = sqliteTable(
  "user_skills",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("us_user_name").on(t.userId, t.name),
  }),
);

export const userMcpServers = sqliteTable(
  "user_mcp_servers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    transport: text("transport").notNull(),
    config: text("config").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("um_user_name").on(t.userId, t.name),
  }),
);

export const userSubagents = sqliteTable(
  "user_subagents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    // tool name whitelist, stored as JSON array
    tools: text("tools").notNull(),
    model: text("model"),
    // SQLite has no native bool; 0/1. Default enabled on create.
    enabled: text("enabled").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("usub_user_name").on(t.userId, t.name),
  }),
);
