import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, and, asc, desc, isNull } from "drizzle-orm";
import { getLogger } from "@octopus/core";
import * as schema from "./schema.js";

// =============================================================================
// SQLite store — backed by better-sqlite3 + Drizzle ORM.
//
// Replaces the earlier JSON-file store. All public exports keep the SAME
// signatures and return shapes (ThreadRow / MessageRow / UserRow) so callers
// (auth.ts, chat.ts, app.ts) need no changes.
// =============================================================================

const logger = getLogger("server.db");

// -----------------------------------------------------------------------------
// Row types — public, unchanged from the JSON store era
// -----------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  hashedPassword: string;
  role: "superadmin" | "admin" | "user";
  createdAt: string;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Record<string, unknown>[];
  feedback?: { rating: "like" | "dislike" };
  extraMetadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadRow {
  id: string;
  userId: string;
  title: string;
  agentId: string;
  workspaceId?: string | null;
  /** Persisted access mode (plan/confirm/auto/full). Defaults to "confirm". */
  accessMode: string;
  createdAt: string;
  messages: MessageRow[];
}

/** A workspace row — filesystem-backed directory tracked in the DB. */
export interface WorkspaceRow {
  id: string;
  userId: string;
  name: string;
  /** Absolute host filesystem path of the workspace directory. */
  path: string;
  /** "local" = host dir; "sandbox" = future isolated container (placeholder). */
  environment: "local" | "sandbox";
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Timestamp the user last opened this workspace (drives the recents list). */
  lastOpenedAt?: string | null;
}

/** A user-defined skill row (origin="user-defined", Phase F). */
export interface UserSkillRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** A user-defined MCP server row (origin="user-defined", Phase F). */
export interface UserMcpServerRow {
  id: string;
  userId: string;
  name: string;
  transport: "stdio" | "sse" | "http" | "streamable-http";
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A user-defined subagent row (origin="user-defined"). */
export interface UserSubagentRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A built-in subagent model override row (model null = default model). */
export interface BuiltinSubagentOverrideRow {
  id: string;
  userId: string;
  name: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A user-defined slash command row (origin="user-defined"). */
export interface UserSlashCommandRow {
  id: string;
  userId: string;
  name: string;
  displayName: string;
  description: string;
  promptTemplate: string;
  action: "insert" | "send";
  category: string | null;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// Connection management — module-level singleton, lazily initialized.
// -----------------------------------------------------------------------------

const DB_PATH =
  process.env["OCTOPUS_DB_PATH"]?.trim() || "data/octopus.db";

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _raw: Database.Database | null = null;

/** Ensure the parent directory for the DB file exists. */
function ensureDir(path: string): void {
  const dir = dirname(path);
  // Relative paths resolve against the server process cwd (server/).
  if (!isAbsolute(dir) || !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Open (or reuse) the SQLite connection, enable WAL + FK enforcement, and
 * create tables if missing. Idempotent — safe to call on every request.
 */
function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  ensureDir(DB_PATH);
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Inline DDL — keeps deployment single-file, no separate migration step.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      hashed_password TEXT NOT NULL,
      role          TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role           TEXT NOT NULL,
      content        TEXT NOT NULL,
      tool_calls     TEXT,
      feedback       TEXT,
      extra_metadata TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_user_id   ON threads(user_id);

    -- Phase F: user-defined skill/mcp config (see ARCHITECTURE_PLAN §11).
    -- File-source configs are NOT stored here; only web/tui-created entries.
    CREATE TABLE IF NOT EXISTS user_skills (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      transport   TEXT NOT NULL,
      config      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS user_subagents (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tools         TEXT NOT NULL,
      model         TEXT,
      enabled       TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
    -- Per-user model overrides for built-in subagents (model NULL = default).
    CREATE TABLE IF NOT EXISTS builtin_subagent_overrides (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      model       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS user_slash_commands (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      name            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      description     TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      action          TEXT NOT NULL DEFAULT 'insert',
      category        TEXT,
      icon            TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE(user_id, name)
    );

    -- Workspaces (filesystem-backed, DB-tracked). See schema.ts.
    CREATE TABLE IF NOT EXISTS workspaces (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      name           TEXT NOT NULL,
      path           TEXT NOT NULL,
      environment    TEXT NOT NULL DEFAULT 'local',
      description    TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      last_opened_at TEXT,
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
  `);

  // --- Idempotent column additions for pre-existing DB files ---
  // SQLite raises "duplicate column name" if the column already exists; we
  // swallow that single error so the ALTER is safe to re-run. This keeps the
  // inline DDL model (no migration runner) while evolving the schema.
  try {
    sqlite.exec(`ALTER TABLE threads ADD COLUMN workspace_id TEXT;`);
  } catch (err: any) {
    if (!/duplicate column/i.test(err?.message ?? "")) throw err;
  }
  try {
    // Persisted access mode (plan/confirm/auto/full). Nullable so legacy rows
    // (pre-existing DB files) coerce to the "confirm" default in mapThread.
    sqlite.exec(`ALTER TABLE threads ADD COLUMN access_mode TEXT;`);
  } catch (err: any) {
    if (!/duplicate column/i.test(err?.message ?? "")) throw err;
  }
  try {
    sqlite.exec(`ALTER TABLE workspaces ADD COLUMN environment TEXT NOT NULL DEFAULT 'local';`);
  } catch (err: any) {
    if (!/duplicate column/i.test(err?.message ?? "")) throw err;
  }
  try {
    sqlite.exec(`ALTER TABLE workspaces ADD COLUMN last_opened_at TEXT;`);
  } catch (err: any) {
    if (!/duplicate column/i.test(err?.message ?? "")) throw err;
  }

  _raw = sqlite;
  _db = drizzle(sqlite, { schema });
  logger.info(`SQLite store opened at ${DB_PATH}`);
  return _db;
}

// -----------------------------------------------------------------------------
// JSON field helpers — toolCalls / feedback / extraMetadata are stored as TEXT.
// -----------------------------------------------------------------------------

function packJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function unpackJson<T = unknown>(raw: string | null): T | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Row mappers — translate flat snake_case DB rows into the public camelCase
// shapes that callers expect.
// -----------------------------------------------------------------------------

function mapUser(u: typeof schema.users.$inferSelect): UserRow {
  return {
    id: u.id,
    username: u.username,
    hashedPassword: u.hashedPassword,
    role: u.role as UserRow["role"],
    createdAt: u.createdAt,
  };
}

function mapMessage(m: typeof schema.messages.$inferSelect): MessageRow {
  const row: MessageRow = {
    id: m.id,
    role: m.role as MessageRow["role"],
    content: m.content,
    createdAt: m.createdAt,
  };
  const toolCalls = unpackJson<Record<string, unknown>[]>(m.toolCalls);
  if (toolCalls) row.toolCalls = toolCalls;
  const feedback = unpackJson<{ rating: "like" | "dislike" }>(m.feedback);
  if (feedback) row.feedback = feedback;
  const extra = unpackJson<Record<string, unknown>>(m.extraMetadata);
  if (extra) row.extraMetadata = extra;
  return row;
}

function mapThread(
  t: typeof schema.threads.$inferSelect,
  msgs: MessageRow[] = [],
): ThreadRow {
  const row: ThreadRow = {
    id: t.id,
    userId: t.userId,
    title: t.title,
    agentId: t.agentId,
    // Legacy rows (created before access_mode existed) have NULL — coerce to
    // the default per-step-approval mode so resume behaves as before.
    accessMode: t.accessMode ?? "confirm",
    createdAt: t.createdAt,
    messages: msgs,
  };
  if (t.workspaceId != null) row.workspaceId = t.workspaceId;
  return row;
}

function mapWorkspace(w: typeof schema.workspaces.$inferSelect): WorkspaceRow {
  const row: WorkspaceRow = {
    id: w.id,
    userId: w.userId,
    name: w.name,
    path: w.path,
    environment: (w.environment as WorkspaceRow["environment"]) ?? "local",
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    lastOpenedAt: w.lastOpenedAt ?? null,
  };
  if (w.description != null) row.description = w.description;
  return row;
}

// =============================================================================
// Public API — init + users CRUD
// =============================================================================

/** Initialize the DB connection and schema. Idempotent. */
export function initDb(): void {
  getDb();
}

export function listUsers(): UserRow[] {
  return getDb().select().from(schema.users).all().map(mapUser);
}

export function getUserById(id: string): UserRow | undefined {
  const row = getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
  return row ? mapUser(row) : undefined;
}

export function getUserByUsername(username: string): UserRow | undefined {
  const row = getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .get();
  return row ? mapUser(row) : undefined;
}

export function createUser(user: UserRow): void {
  getDb()
    .insert(schema.users)
    .values({
      id: user.id,
      username: user.username,
      hashedPassword: user.hashedPassword,
      role: user.role,
      createdAt: user.createdAt,
    })
    .run();
}

/**
 * No-op kept for backward compatibility. The JSON store cached reads in memory;
 * SQLite is always consistent so there is nothing to invalidate.
 */
export function invalidateCache(): void {
  // intentionally empty
}

// =============================================================================
// Threads CRUD
// =============================================================================

export function createThread(params: {
  id: string;
  userId: string;
  title?: string;
  agentId?: string;
  workspaceId?: string | null;
  accessMode?: string;
}): ThreadRow {
  const createdAt = new Date().toISOString();
  const workspaceId = params.workspaceId ?? null;
  const accessMode = params.accessMode ?? "confirm";
  getDb()
    .insert(schema.threads)
    .values({
      id: params.id,
      userId: params.userId,
      title: params.title ?? "新对话",
      agentId: params.agentId ?? "ChatbotAgent",
      workspaceId,
      accessMode,
      createdAt,
    })
    .run();
  const row: ThreadRow = {
    id: params.id,
    userId: params.userId,
    title: params.title ?? "新对话",
    agentId: params.agentId ?? "ChatbotAgent",
    accessMode,
    createdAt,
    messages: [],
  };
  if (workspaceId != null) row.workspaceId = workspaceId;
  return row;
}

export function getThread(id: string): ThreadRow | undefined {
  const db = getDb();
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  if (!thread) return undefined;
  const msgs = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, id))
    .orderBy(asc(schema.messages.createdAt))
    .all()
    .map(mapMessage);
  return mapThread(thread, msgs);
}

export function listThreads(userId: string): ThreadRow[] {
  const db = getDb();
  // Threads list view typically excludes messages; load them lazily via getThread.
  const rows = db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.userId, userId))
    .orderBy(desc(schema.threads.createdAt))
    .all();
  return rows.map((t) => mapThread(t, []));
}

export function updateThreadTitle(id: string, title: string): ThreadRow | undefined {
  const db = getDb();
  const existing = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  if (!existing) return undefined;
  db.update(schema.threads).set({ title }).where(eq(schema.threads.id, id)).run();
  return mapThread({ ...existing, title }, []);
}

/**
 * Persist the user's current access mode on the thread. This is what makes a
 * mid-run mode switch take effect at the next approval point: the resume
 * endpoint reads `thread.accessMode` and rebuilds the interruptOn override
 * accordingly, so the in-flight turn honors the latest mode without needing
 * a new message.
 */
export function updateThreadAccessMode(id: string, accessMode: string): ThreadRow | undefined {
  const db = getDb();
  const existing = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  if (!existing) return undefined;
  db.update(schema.threads).set({ accessMode }).where(eq(schema.threads.id, id)).run();
  return mapThread({ ...existing, accessMode }, []);
}

export function deleteThread(id: string): void {
  // FK ON DELETE CASCADE removes associated messages automatically.
  getDb().delete(schema.threads).where(eq(schema.threads.id, id)).run();
}

// =============================================================================
// Messages CRUD
// =============================================================================

export function getMessages(threadId: string): MessageRow[] {
  return getDb()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, threadId))
    .orderBy(asc(schema.messages.createdAt))
    .all()
    .map(mapMessage);
}

export function addMessage(threadId: string, msg: MessageRow): void {
  getDb()
    .insert(schema.messages)
    .values({
      id: msg.id,
      threadId,
      role: msg.role,
      content: msg.content,
      toolCalls: packJson(msg.toolCalls),
      feedback: packJson(msg.feedback),
      extraMetadata: packJson(msg.extraMetadata),
      createdAt: msg.createdAt,
    })
    .run();
}

export function addMessages(threadId: string, msgs: MessageRow[]): void {
  if (msgs.length === 0) return;
  const db = getDb();
  // Single transaction for atomic batch insert.
  db.transaction((tx) => {
    for (const msg of msgs) {
      tx.insert(schema.messages)
        .values({
          id: msg.id,
          threadId,
          role: msg.role,
          content: msg.content,
          toolCalls: packJson(msg.toolCalls),
          feedback: packJson(msg.feedback),
          extraMetadata: packJson(msg.extraMetadata),
          createdAt: msg.createdAt,
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

// =============================================================================
// User-defined skill config (Phase F — see ARCHITECTURE_PLAN §11)
// =============================================================================

export function listUserSkills(userId: string): UserSkillRow[] {
  return getDb()
    .select()
    .from(schema.userSkills)
    .where(eq(schema.userSkills.userId, userId))
    .all()
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      description: r.description,
      content: r.content,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

export function getUserSkill(userId: string, name: string): UserSkillRow | undefined {
  const db = getDb();
  const r = db
    .select()
    .from(schema.userSkills)
    .where(
      and(eq(schema.userSkills.userId, userId), eq(schema.userSkills.name, name)),
    )
    .get();
  return r
    ? {
        id: r.id,
        userId: r.userId,
        name: r.name,
        description: r.description,
        content: r.content,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    : undefined;
}

export function upsertUserSkill(row: UserSkillRow): void {
  const now = new Date().toISOString();
  getDb()
    .insert(schema.userSkills)
    .values({
      id: row.id,
      userId: row.userId,
      name: row.name,
      description: row.description,
      content: row.content,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.userSkills.userId, schema.userSkills.name],
      set: {
        description: row.description,
        content: row.content,
        updatedAt: now,
      },
    })
    .run();
}

export function deleteUserSkill(userId: string, name: string): void {
  getDb()
    .delete(schema.userSkills)
    .where(
      and(eq(schema.userSkills.userId, userId), eq(schema.userSkills.name, name)),
    )
    .run();
}

// =============================================================================
// User-defined MCP server config (Phase F — see ARCHITECTURE_PLAN §11)
// =============================================================================

export function listUserMcpServers(userId: string): UserMcpServerRow[] {
  return getDb()
    .select()
    .from(schema.userMcpServers)
    .where(eq(schema.userMcpServers.userId, userId))
    .all()
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      transport: r.transport as UserMcpServerRow["transport"],
      config: unpackJson<Record<string, unknown>>(r.config) ?? {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

export function getUserMcpServer(
  userId: string,
  name: string,
): UserMcpServerRow | undefined {
  const db = getDb();
  const r = db
    .select()
    .from(schema.userMcpServers)
    .where(
      and(eq(schema.userMcpServers.userId, userId), eq(schema.userMcpServers.name, name)),
    )
    .get();
  return r
    ? {
        id: r.id,
        userId: r.userId,
        name: r.name,
        transport: r.transport as UserMcpServerRow["transport"],
        config: unpackJson<Record<string, unknown>>(r.config) ?? {},
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    : undefined;
}

export function upsertUserMcpServer(row: UserMcpServerRow): void {
  const now = new Date().toISOString();
  getDb()
    .insert(schema.userMcpServers)
    .values({
      id: row.id,
      userId: row.userId,
      name: row.name,
      transport: row.transport,
      config: packJson(row.config) ?? "{}",
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.userMcpServers.userId, schema.userMcpServers.name],
      set: {
        transport: row.transport,
        config: packJson(row.config) ?? "{}",
        updatedAt: now,
      },
    })
    .run();
}

export function deleteUserMcpServer(userId: string, name: string): void {
  getDb()
    .delete(schema.userMcpServers)
    .where(
      and(eq(schema.userMcpServers.userId, userId), eq(schema.userMcpServers.name, name)),
    )
    .run();
}

// =============================================================================
// User-defined subagent config
// =============================================================================

export function listUserSubagents(userId: string): UserSubagentRow[] {
  return getDb()
    .select()
    .from(schema.userSubagents)
    .where(eq(schema.userSubagents.userId, userId))
    .all()
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      description: r.description,
      systemPrompt: r.systemPrompt,
      tools: unpackJson<string[]>(r.tools) ?? [],
      model: r.model,
      enabled: r.enabled === "1" || r.enabled === "true",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

export function getUserSubagent(userId: string, name: string): UserSubagentRow | undefined {
  const db = getDb();
  const r = db
    .select()
    .from(schema.userSubagents)
    .where(
      and(eq(schema.userSubagents.userId, userId), eq(schema.userSubagents.name, name)),
    )
    .get();
  return r
    ? {
        id: r.id,
        userId: r.userId,
        name: r.name,
        description: r.description,
        systemPrompt: r.systemPrompt,
        tools: unpackJson<string[]>(r.tools) ?? [],
        model: r.model,
        enabled: r.enabled === "1" || r.enabled === "true",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    : undefined;
}

export function upsertUserSubagent(row: UserSubagentRow): void {
  const now = new Date().toISOString();
  getDb()
    .insert(schema.userSubagents)
    .values({
      id: row.id,
      userId: row.userId,
      name: row.name,
      description: row.description,
      systemPrompt: row.systemPrompt,
      tools: packJson(row.tools) ?? "[]",
      model: row.model,
      enabled: row.enabled ? "1" : "0",
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.userSubagents.userId, schema.userSubagents.name],
      set: {
        description: row.description,
        systemPrompt: row.systemPrompt,
        tools: packJson(row.tools) ?? "[]",
        model: row.model,
        enabled: row.enabled ? "1" : "0",
        updatedAt: now,
      },
    })
    .run();
}

export function deleteUserSubagent(userId: string, name: string): void {
  getDb()
    .delete(schema.userSubagents)
    .where(
      and(eq(schema.userSubagents.userId, userId), eq(schema.userSubagents.name, name)),
    )
    .run();
}

// =============================================================================
// Built-in subagent model overrides
// =============================================================================

export function listBuiltinSubagentOverrides(userId: string): BuiltinSubagentOverrideRow[] {
  return getDb()
    .select()
    .from(schema.builtinSubagentOverrides)
    .where(eq(schema.builtinSubagentOverrides.userId, userId))
    .all()
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      model: r.model,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

export function getBuiltinSubagentOverride(
  userId: string,
  name: string,
): BuiltinSubagentOverrideRow | undefined {
  const r = getDb()
    .select()
    .from(schema.builtinSubagentOverrides)
    .where(
      and(
        eq(schema.builtinSubagentOverrides.userId, userId),
        eq(schema.builtinSubagentOverrides.name, name),
      ),
    )
    .get();
  return r
    ? {
        id: r.id,
        userId: r.userId,
        name: r.name,
        model: r.model,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    : undefined;
}

/** Upsert a built-in subagent's model override (model null = default model). */
export function upsertBuiltinSubagentOverride(
  userId: string,
  name: string,
  model: string | null,
): void {
  const now = new Date().toISOString();
  const existing = getBuiltinSubagentOverride(userId, name);
  getDb()
    .insert(schema.builtinSubagentOverrides)
    .values({
      id: existing?.id ?? `bso_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      name,
      model,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.builtinSubagentOverrides.userId,
        schema.builtinSubagentOverrides.name,
      ],
      set: { model, updatedAt: now },
    })
    .run();
}

// =============================================================================
// Workspaces CRUD (filesystem-backed, DB-tracked — see schema.ts)
// =============================================================================

export function listWorkspaces(userId: string): WorkspaceRow[] {
  // Order by last-opened (recents), then created, so the recents list surfaces
  // recently-used workspaces first. NULL last_opened_at sorts last on SQLite.
  return getDb()
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId))
    .orderBy(desc(schema.workspaces.lastOpenedAt), desc(schema.workspaces.createdAt))
    .all()
    .map(mapWorkspace);
}

export function getWorkspace(userId: string, id: string): WorkspaceRow | undefined {
  const r = getDb()
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.id, id)))
    .get();
  return r ? mapWorkspace(r) : undefined;
}

export function getWorkspaceByName(userId: string, name: string): WorkspaceRow | undefined {
  const r = getDb()
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.name, name)))
    .get();
  return r ? mapWorkspace(r) : undefined;
}

/** Look up a workspace by its bound host path (for Open Folder dedupe). */
export function getWorkspaceByPath(userId: string, path: string): WorkspaceRow | undefined {
  const r = getDb()
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.path, path)))
    .get();
  return r ? mapWorkspace(r) : undefined;
}

export function insertWorkspace(row: WorkspaceRow): WorkspaceRow {
  const now = new Date().toISOString();
  const environment = row.environment ?? "local";
  getDb()
    .insert(schema.workspaces)
    .values({
      id: row.id,
      userId: row.userId,
      name: row.name,
      path: row.path,
      environment,
      description: row.description ?? null,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
      lastOpenedAt: row.lastOpenedAt ?? null,
    })
    .run();
  return { ...row, environment, createdAt: row.createdAt ?? now, updatedAt: now };
}

export function updateWorkspace(
  userId: string,
  id: string,
  patch: { name?: string; description?: string | null; path?: string },
): WorkspaceRow | undefined {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.id, id)))
    .get();
  if (!existing) return undefined;
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.path !== undefined) set.path = patch.path;
  db.update(schema.workspaces)
    .set(set)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.id, id)))
    .run();
  return mapWorkspace({ ...existing, ...(set as Partial<typeof existing>) });
}

/** Bump last_opened_at to now — used when a user opens a workspace. */
export function touchWorkspaceLastOpened(userId: string, id: string): WorkspaceRow | undefined {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.id, id)))
    .get();
  if (!existing) return undefined;
  const now = new Date().toISOString();
  db.update(schema.workspaces)
    .set({ lastOpenedAt: now })
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.id, id)))
    .run();
  return mapWorkspace({ ...existing, lastOpenedAt: now });
}

export function deleteWorkspaceRow(userId: string, id: string): void {
  getDb()
    .delete(schema.workspaces)
    .where(and(eq(schema.workspaces.userId, userId), eq(schema.workspaces.id, id)))
    .run();
}

/** Null-out (or reassign) the workspace binding of threads under a workspace. */
export function reassignThreadsWorkspace(
  userId: string,
  workspaceId: string,
  newWorkspaceId: string | null,
): void {
  getDb()
    .update(schema.threads)
    .set({ workspaceId: newWorkspaceId })
    .where(
      and(eq(schema.threads.userId, userId), eq(schema.threads.workspaceId, workspaceId)),
    )
    .run();
}

/** List threads scoped to a workspace (optional filter). */
export function listThreadsByWorkspace(
  userId: string,
  workspaceId?: string | null,
): ThreadRow[] {
  const db = getDb();
  let rows;
  if (workspaceId === undefined) {
    rows = db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.userId, userId))
      .orderBy(desc(schema.threads.createdAt))
      .all();
  } else if (workspaceId === null) {
    rows = db
      .select()
      .from(schema.threads)
      .where(and(eq(schema.threads.userId, userId), isNull(schema.threads.workspaceId)))
      .orderBy(desc(schema.threads.createdAt))
      .all();
  } else {
    rows = db
      .select()
      .from(schema.threads)
      .where(
        and(
          eq(schema.threads.userId, userId),
          eq(schema.threads.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(schema.threads.createdAt))
      .all();
  }
  return rows.map((t) => mapThread(t, []));
}

// =============================================================================
// User-defined slash commands
// =============================================================================

export function listUserSlashCommands(userId: string): UserSlashCommandRow[] {
  return getDb()
    .select()
    .from(schema.userSlashCommands)
    .where(eq(schema.userSlashCommands.userId, userId))
    .all()
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      promptTemplate: r.promptTemplate,
      action: r.action as UserSlashCommandRow["action"],
      category: r.category ?? null,
      icon: r.icon ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

export function getUserSlashCommand(userId: string, id: string): UserSlashCommandRow | undefined {
  const db = getDb();
  const r = db
    .select()
    .from(schema.userSlashCommands)
    .where(
      and(eq(schema.userSlashCommands.userId, userId), eq(schema.userSlashCommands.id, id)),
    )
    .get();
  return r
    ? {
        id: r.id,
        userId: r.userId,
        name: r.name,
        displayName: r.displayName,
        description: r.description,
        promptTemplate: r.promptTemplate,
        action: r.action as UserSlashCommandRow["action"],
        category: r.category ?? null,
        icon: r.icon ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    : undefined;
}

export function upsertUserSlashCommand(row: UserSlashCommandRow): void {
  const now = new Date().toISOString();
  getDb()
    .insert(schema.userSlashCommands)
    .values({
      id: row.id,
      userId: row.userId,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      promptTemplate: row.promptTemplate,
      action: row.action,
      category: row.category,
      icon: row.icon,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.userSlashCommands.userId, schema.userSlashCommands.name],
      set: {
        displayName: row.displayName,
        description: row.description,
        promptTemplate: row.promptTemplate,
        action: row.action,
        category: row.category,
        icon: row.icon,
        updatedAt: now,
      },
    })
    .run();
}

export function deleteUserSlashCommand(userId: string, id: string): void {
  getDb()
    .delete(schema.userSlashCommands)
    .where(
      and(eq(schema.userSlashCommands.userId, userId), eq(schema.userSlashCommands.id, id)),
    )
    .run();
}
