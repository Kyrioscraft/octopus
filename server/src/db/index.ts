import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// Simple JSON-file store — Phase 1 alternative to SQLite (no native deps).
//
// Replaced by Drizzle + better-sqlite3 in Phase 2 when more tables are needed.
// =============================================================================

export interface UserRow {
  id: string;
  username: string;
  hashedPassword: string;
  role: "superadmin" | "admin" | "user";
  createdAt: string;
}

interface StoreData {
  users: UserRow[];
}

const DATA_FILE = process.env["OCTOPUS_DB_PATH"] ?? "data/octopus.json";

let _cache: StoreData | null = null;

function readStore(): StoreData {
  if (_cache) return _cache;
  if (!existsSync(DATA_FILE)) {
    return { users: [] };
  }
  _cache = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as StoreData;
  return _cache;
}

function writeStore(data: StoreData): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  _cache = data;
}

// =============================================================================
// Users CRUD
// =============================================================================

export function initDb(): void {
  readStore(); // triggers lazy creation on next write
}

export function listUsers(): UserRow[] {
  return readStore().users;
}

export function getUserById(id: string): UserRow | undefined {
  return readStore().users.find((u) => u.id === id);
}

export function getUserByUsername(username: string): UserRow | undefined {
  return readStore().users.find((u) => u.username === username);
}

export function createUser(user: UserRow): void {
  const store = readStore();
  store.users.push(user);
  writeStore(store);
}

// Invalidate cache (for external changes)
export function invalidateCache(): void {
  _cache = null;
}

// =============================================================================
// Threads + Messages CRUD
// =============================================================================

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
  createdAt: string;
  messages: MessageRow[];
}

const THREADS_FILE = "data/threads.json";

let _threadsCache: ThreadRow[] | null = null;

function readThreads(): ThreadRow[] {
  if (_threadsCache) return _threadsCache;
  if (!existsSync(THREADS_FILE)) {
    return [];
  }
  _threadsCache = JSON.parse(readFileSync(THREADS_FILE, "utf-8")) as ThreadRow[];
  return _threadsCache;
}

function writeThreads(data: ThreadRow[]): void {
  mkdirSync(dirname(THREADS_FILE), { recursive: true });
  writeFileSync(THREADS_FILE, JSON.stringify(data, null, 2), "utf-8");
  _threadsCache = data;
}

export function createThread(params: {
  id: string;
  userId: string;
  title?: string;
  agentId?: string;
}): ThreadRow {
  const thread: ThreadRow = {
    id: params.id,
    userId: params.userId,
    title: params.title ?? "新对话",
    agentId: params.agentId ?? "ChatbotAgent",
    createdAt: new Date().toISOString(),
    messages: [],
  };
  const threads = readThreads();
  threads.push(thread);
  writeThreads(threads);
  return thread;
}

export function getThread(id: string): ThreadRow | undefined {
  return readThreads().find((t) => t.id === id);
}

export function listThreads(userId: string): ThreadRow[] {
  return readThreads()
    .filter((t) => t.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateThreadTitle(id: string, title: string): ThreadRow | undefined {
  const threads = readThreads();
  const t = threads.find((r) => r.id === id);
  if (!t) return undefined;
  t.title = title;
  writeThreads(threads);
  return t;
}

export function deleteThread(id: string): void {
  writeThreads(readThreads().filter((t) => t.id !== id));
}

export function getMessages(threadId: string): MessageRow[] {
  return getThread(threadId)?.messages ?? [];
}

export function addMessage(threadId: string, msg: MessageRow): void {
  // Ensure thread exists
  const threads = readThreads();
  const t = threads.find((r) => r.id === threadId);
  if (!t) return;
  t.messages.push(msg);
  writeThreads(threads);
}

export function addMessages(threadId: string, msgs: MessageRow[]): void {
  const threads = readThreads();
  const t = threads.find((r) => r.id === threadId);
  if (!t) return;
  t.messages.push(...msgs);
  writeThreads(threads);
}
