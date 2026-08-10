/**
 * Workspace service — business rules for workspaces + their files.
 *
 * A workspace is a per-user directory (DB-tracked via the `workspaces` table,
 * physically at `data/workspaces/<userId>/<workspaceId>/`). This service owns:
 *   - workspace CRUD (DB + disk mkdir/rmtree together)
 *   - file tree listing, read, write, mkdir, delete, download
 *   - centralized preview-type detection (`detectPreviewType`)
 *
 * No Hono dependency — the route layer is a thin HTTP adapter. Equivalent in
 * spirit to yuxi's `workspace_service.py` + `viewer_filesystem_service.py`,
 * adapted for octopus's DB-tracked model.
 */

import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { v4 as uuid } from "uuid";
import { getLogger } from "@octopus/core";
import {
  deleteWorkspaceRow,
  getWorkspace,
  getWorkspaceByName,
  getWorkspaceByPath,
  insertWorkspace,
  listWorkspaces,
  reassignThreadsWorkspace,
  touchWorkspaceLastOpened,
  updateWorkspace,
} from "../db/index.js";
import type { WorkspaceRow } from "../db/index.js";
import {
  ensureDir,
  isDirectory,
  relativePath,
  resolveSafePath,
  threadOutputsDir,
  validateSegment,
  workspaceDir,
  browsableRoots,
  isWithinBrowsableRoots,
  PathTraversalError,
} from "./workspace_paths.js";

// Re-export so the route layer can import all workspace errors from one place.
export { PathTraversalError };

const logger = getLogger("server.workspace.service");

// =============================================================================
// Errors
// =============================================================================

export class NotFoundError extends Error {
  constructor(message = "工作区不存在") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class NotEditableError extends Error {
  readonly origin = "workspace";
  constructor(message = "该文件类型不支持在线编辑") {
    super(message);
    this.name = "NotEditableError";
  }
}

// =============================================================================
// Preview-type detection — single source of truth (matches yuxi `_detect_preview_type`)
// =============================================================================

export type PreviewType = "image" | "pdf" | "markdown" | "text" | "html" | "code" | "unsupported";

export interface PreviewResult {
  content: string | null;
  previewType: PreviewType;
  supported: boolean;
  message?: string;
}

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif",
]);
const PDF_EXT = new Set([".pdf"]);
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
const HTML_EXT = new Set([".html", ".htm"]);
// Text extensions are intentionally a curated set; the binary fallback below
// catches the rest.
const TEXT_EXT = new Set([
  ".txt", ".log", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".env", ".json",
  ".yaml", ".yml", ".toml", ".xml", ".css", ".scss", ".less",
]);
// Code extensions — previewed as syntax-highlighted text.
const CODE_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".php", ".swift",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".sql", ".r",
  ".scala", ".clj", ".ex", ".exs", ".erl", ".lua", ".vim", ".dockerfile",
  ".makefile", ".gradle", ".vue", ".svelte",
]);

// Binary magic-number signatures (used when the extension is ambiguous).
const BINARY_SIGNATURES: Array<{ offset: number; bytes: number[] }> = [
  { offset: 0, bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // PDF
  { offset: 0, bytes: [0x42, 0x4d] }, // BMP
  { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }, // TIFF LE
  { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // TIFF BE
  { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }, // 7z
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // zip
  { offset: 0, bytes: [0x1f, 0x8b] }, // gzip
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // mp4/mov (ftyp)
];

function matchesSignature(buf: Buffer, sig: { offset: number; bytes: number[] }): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buf[sig.offset + i] === b);
}

function isBinaryBuffer(buf: Buffer): boolean {
  if (BINARY_SIGNATURES.some((s) => matchesSignature(buf, s))) return true;
  // Heuristic: a NUL byte in the first 8KB → binary.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/**
 * Classify a file for preview. Reads the file once if needed; returns content
 * for text-like types and `null` for binary types (the client fetches a blob
 * via the download endpoint).
 */
export function detectPreviewType(absPath: string, rawBytes?: Buffer): PreviewResult {
  const ext = extname(absPath).toLowerCase();

  // Binary-by-extension: never inline content.
  if (IMAGE_EXT.has(ext)) {
    return { content: null, previewType: "image", supported: true };
  }
  if (PDF_EXT.has(ext)) {
    return { content: null, previewType: "pdf", supported: true };
  }

  // Need bytes to decide for everything else.
  let buf: Buffer;
  try {
    buf = rawBytes ?? readFileSync(absPath);
  } catch {
    return {
      content: null,
      previewType: "unsupported",
      supported: false,
      message: "无法读取文件内容",
    };
  }

  if (MARKDOWN_EXT.has(ext)) {
    return { content: buf.toString("utf8"), previewType: "markdown", supported: true };
  }
  if (HTML_EXT.has(ext)) {
    return { content: buf.toString("utf8"), previewType: "html", supported: true };
  }
  if (TEXT_EXT.has(ext)) {
    return { content: buf.toString("utf8"), previewType: "text", supported: true };
  }
  if (CODE_EXT.has(ext)) {
    return { content: buf.toString("utf8"), previewType: "code", supported: true };
  }

  // Unknown extension — sniff.
  if (isBinaryBuffer(buf)) {
    return {
      content: null,
      previewType: "unsupported",
      supported: false,
      message: "该文件为二进制格式，不支持在线预览，可下载后查看",
    };
  }
  // UTF-8 decodable and not binary — treat as text.
  return { content: buf.toString("utf8"), previewType: "text", supported: true };
}

/** Map a preview type to a code-language hint (for the frontend highlighter). */
export function codeLanguageByPath(absPath: string): string {
  return extname(absPath).slice(1).toLowerCase();
}

// =============================================================================
// Workspace CRUD
// =============================================================================

export function listAllWorkspaces(userId: string): WorkspaceRow[] {
  return listWorkspaces(userId);
}

export function getWorkspaceDetail(userId: string, id: string): WorkspaceRow | undefined {
  return getWorkspace(userId, id);
}

export interface WorkspaceCreateInput {
  name: string;
  description?: string | null;
  /** "local" creates a real host dir; "sandbox" is a placeholder row only. */
  environment?: "local" | "sandbox";
  /**
   * Optional absolute host path to bind as the workspace root (local only).
   * When provided, the workspace operates directly on this directory (created
   * if missing) instead of a server-managed path. The name still identifies
   * the row; it defaults to the bound directory's basename.
   */
  path?: string;
}

export function createWorkspace(userId: string, input: WorkspaceCreateInput): WorkspaceRow {
  const environment = input.environment ?? "local";
  const id = `ws_${uuid()}`;

  // Resolve the workspace root path + display name.
  let path: string;
  let name: string;

  if (environment === "sandbox") {
    name = input.name.trim();
    if (!name) throw new Error("工作区名称不能为空");
    validateSegment(name);
    if (getWorkspaceByName(userId, name)) {
      throw new Error("同名工作区已存在");
    }
    path = `sandbox://${name}`;
  } else if (input.path && input.path.trim()) {
    // Client-bound local directory: operate directly on the host path.
    // Validate the RAW input before resolve() turns a relative path absolute.
    const raw = input.path.trim();
    if (!isAbsolute(raw)) {
      throw new Error("绑定路径必须是绝对路径");
    }
    if (raw.includes("..")) {
      throw new Error("绑定路径不能包含 ..");
    }
    const bound = resolve(raw);
    // The bound directory must live within a configured browsable root, so a
    // client can't bind arbitrary sensitive host paths.
    if (!isWithinBrowsableRoots(bound)) {
      throw new Error("该目录不在允许浏览的根目录范围内");
    }
    ensureDir(bound);
    path = bound;
    // Name: explicit input, else the bound directory's basename.
    name = (input.name?.trim() || bound.split(/[\\/]/).filter(Boolean).pop() || "workspace");
  } else {
    name = input.name.trim();
    if (!name) throw new Error("工作区名称不能为空");
    validateSegment(name);
    if (getWorkspaceByName(userId, name)) {
      throw new Error("同名工作区已存在");
    }
    path = workspaceDir(userId, id);
    ensureDir(path);
  }

  logger.info(`Workspace created: ${id} env=${environment} path=${path} (user=${userId})`);

  const now = new Date().toISOString();
  return insertWorkspace({
    id,
    userId,
    name,
    path,
    environment,
    description: input.description?.trim() || null,
    createdAt: now,
    updatedAt: now,
  });
}

// =============================================================================
// Host directory browser — powers the "本机目录" picker. Lists subdirectories
// of a host path, constrained to the configured browsable roots.
// =============================================================================

export interface HostDirEntry {
  name: string;
  /** Absolute path of the directory. */
  path: string;
}

export interface HostBrowseResult {
  /** The absolute path that was listed. */
  current: string;
  /** Subdirectories (files excluded — picker only selects folders). */
  entries: HostDirEntry[];
  /** The configured browsable roots, for the picker's root selector. */
  roots: string[];
}

/**
 * List the subdirectories of `absPath` (defaults to the first browsable root).
 * Refuses paths outside the browsable roots and non-directory inputs.
 */
export function listHostDirs(absPath?: string): HostBrowseResult {
  const roots = browsableRoots();
  const current = absPath?.trim() ? resolve(absPath.trim()) : roots[0];
  if (!current) {
    throw new Error("未配置可浏览的根目录 (OCTOPUS_WORKSPACE_BROWSABLE_ROOTS)");
  }
  if (!isWithinBrowsableRoots(current)) {
    throw new PathTraversalError("该目录不在允许浏览的根目录范围内");
  }
  if (!existsSync(current) || !isDirectory(current)) {
    throw new Error("目录不存在");
  }

  let names: string[];
  try {
    names = readdirSync(current);
  } catch (err) {
    logger.exception(`Failed to read host dir ${current}`, err as Error);
    return { current, entries: [], roots };
  }

  const entries: HostDirEntry[] = [];
  for (const name of names) {
    // Skip hidden dirs unless they start with the OS tmp prefix (rare). Keep it
    // simple: show non-hidden directories only.
    if (name.startsWith(".")) continue;
    const child = join(current, name);
    try {
      if (isDirectory(child)) {
        entries.push({ name, path: child });
      }
    } catch {
      /* skip unreadable */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"));
  return { current, entries, roots };
}

export interface WorkspaceUpdateInput {
  name?: string;
  description?: string | null;
}

export function updateWorkspaceMeta(
  userId: string,
  id: string,
  patch: WorkspaceUpdateInput,
): WorkspaceRow | undefined {
  const existing = getWorkspace(userId, id);
  if (!existing) return undefined;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("工作区名称不能为空");
    validateSegment(name);
    const clash = getWorkspaceByName(userId, name);
    if (clash && clash.id !== id) throw new Error("同名工作区已存在");
    patch = { ...patch, name };
  }
  return updateWorkspace(userId, id, patch);
}

/**
 * Delete a workspace: null-out bound threads' workspace_id (keep threads),
 * rmtree the directory, then remove the row.
 */
export function deleteWorkspace(userId: string, id: string): void {
  const existing = getWorkspace(userId, id);
  if (!existing) throw new NotFoundError();
  reassignThreadsWorkspace(userId, id, null);
  try {
    rmSync(existing.path, { recursive: true, force: true });
  } catch (err) {
    logger.exception(`Failed to rmtree workspace ${id}`, err as Error);
  }
  deleteWorkspaceRow(userId, id);
  logger.info(`Workspace deleted: ${id} (user=${userId})`);
}

/**
 * Return (creating if missing) the user's DemoProject workspace — the default
 * local working directory every thread falls back to. Each user gets exactly
 * one auto-created `DemoProject` directory under their managed root.
 */
export function getOrCreateDemoProject(userId: string): WorkspaceRow {
  const DEMO_NAME = "DemoProject";
  const existing = getWorkspaceByName(userId, DEMO_NAME);
  if (existing) return existing;
  return createWorkspace(userId, { name: DEMO_NAME, environment: "local" });
}

/** Back-compat alias. */
export const getOrCreateDefaultWorkspace = getOrCreateDemoProject;

/**
 * Open (or create) a workspace bound to a real host directory — the IDE-style
 * "Open Folder" action. Reuses an existing row with the same `path` (dedupe),
 * bumps `last_opened_at` so it surfaces in recents, and returns the row.
 *
 * The path must be absolute, within the browsable roots, and an existing
 * directory. The agent will operate directly in this directory.
 */
export function openOrCreateWorkspace(userId: string, hostPath: string): WorkspaceRow {
  const raw = hostPath.trim();
  if (!isAbsolute(raw)) throw new Error("绑定路径必须是绝对路径");
  if (raw.includes("..")) throw new Error("绑定路径不能包含 ..");
  const bound = resolve(raw);
  if (!isWithinBrowsableRoots(bound)) {
    throw new Error("该目录不在允许浏览的根目录范围内");
  }
  if (!existsSync(bound) || !isDirectory(bound)) {
    throw new Error("目录不存在");
  }

  // Dedupe by path: reopen the existing workspace instead of creating a dup.
  const existing = getWorkspaceByPath(userId, bound);
  if (existing) {
    const touched = touchWorkspaceLastOpened(userId, existing.id);
    return touched ?? existing;
  }

  const name = bound.split(/[\\/]/).filter(Boolean).pop() || "workspace";
  // If a different workspace already holds this name, suffix to avoid the
  // UNIQUE(user_id, name) collision.
  let finalName = name;
  let n = 2;
  while (getWorkspaceByName(userId, finalName)) {
    finalName = `${name}-${n++}`;
  }
  const id = `ws_${uuid()}`;
  const now = new Date().toISOString();
  logger.info(`Workspace opened (Open Folder): ${id} path=${bound} (user=${userId})`);
  return insertWorkspace({
    id,
    userId,
    name: finalName,
    path: bound,
    environment: "local",
    description: null,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  });
}

/** List workspaces ordered by most-recently-opened first (recents list). */
export function listRecentWorkspaces(userId: string): WorkspaceRow[] {
  return listWorkspaces(userId);
}

// =============================================================================
// File operations (all path-safe; scoped to a workspace)
// =============================================================================

/** Resolve the on-disk root for a workspace, or throw NotFoundError. */
function requireRoot(userId: string, workspaceId: string): { root: string; row: WorkspaceRow } {
  const row = getWorkspace(userId, workspaceId);
  if (!row) throw new NotFoundError();
  if (row.environment === "sandbox") {
    throw new Error("沙盒环境尚未接入，暂不支持文件操作");
  }
  ensureDir(row.path);
  return { root: row.path, row };
}

export interface TreeEntry {
  name: string;
  /** Forward-slash relative path within the workspace root ("" = root). */
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

export function listTree(
  userId: string,
  workspaceId: string,
  rel?: string,
  recursive = false,
): TreeEntry[] {
  const { root } = requireRoot(userId, workspaceId);
  const abs = resolveSafePath(root, rel);
  if (!isDirectory(abs)) throw new Error("指定路径不是目录");

  const out: TreeEntry[] = [];
  const walk = (dirAbs: string): void => {
    let names: string[];
    try {
      names = readdirSync(dirAbs);
    } catch {
      return;
    }
    for (const name of names) {
      const childAbs = join(dirAbs, name);
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      const relPath = relativePath(root, childAbs);
      out.push({
        name,
        path: relPath,
        isDir: st.isDirectory(),
        size: st.isFile() ? st.size : 0,
        modifiedAt: st.mtime.toISOString(),
      });
      if (recursive && st.isDirectory()) walk(childAbs);
    }
  };
  walk(abs);
  // Directories first, then files; alphabetical within each group.
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans");
  });
  return out;
}

export function readFile(
  userId: string,
  workspaceId: string,
  rel: string,
): PreviewResult & { name: string; path: string } {
  const { root } = requireRoot(userId, workspaceId);
  const abs = resolveSafePath(root, rel);
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    throw new NotFoundError("文件不存在");
  }
  const result = detectPreviewType(abs, buf);
  return { ...result, name: basename(abs), path: relativePath(root, abs) };
}

export function writeFile(
  userId: string,
  workspaceId: string,
  rel: string,
  content: string,
): { path: string } {
  const { root } = requireRoot(userId, workspaceId);
  const abs = resolveSafePath(root, rel);
  const ext = extname(abs).toLowerCase();
  const editable = MARKDOWN_EXT.has(ext) || ext === ".txt";
  if (!editable) {
    // Allow creating new text files even without an extension? No — keep the
    // yuxi rule: only known-editable extensions.
    throw new NotEditableError();
  }
  ensureDir(dirname(abs));
  writeFileSync(abs, content, "utf8");
  return { path: relativePath(root, abs) };
}

export function createDirectory(
  userId: string,
  workspaceId: string,
  parentRel: string | undefined,
  name: string,
): { path: string } {
  validateSegment(name);
  const { root } = requireRoot(userId, workspaceId);
  const parentAbs = resolveSafePath(root, parentRel);
  if (!isDirectory(parentAbs)) throw new Error("父路径不是目录");
  const abs = resolveSafePath(root, parentRel ? `${parentRel}/${name}` : name);
  ensureDir(abs);
  return { path: relativePath(root, abs) };
}

export function deletePath(
  userId: string,
  workspaceId: string,
  rel: string,
): { path: string } {
  if (!rel || rel.trim() === "" || rel === "." || rel === "/") {
    throw new Error("工作区根目录不可删除");
  }
  const { root } = requireRoot(userId, workspaceId);
  const abs = resolveSafePath(root, rel);
  if (!existsSyncSafe(abs)) throw new NotFoundError("文件或目录不存在");
  rmSync(abs, { recursive: true, force: true });
  return { path: relativePath(root, abs) };
}

/** existsSync wrapper kept local so call sites read uniformly. */
function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export interface DownloadResult {
  stream: NodeJS.ReadableStream;
  name: string;
  size: number;
  modifiedAt: string;
}

export function downloadFile(
  userId: string,
  workspaceId: string,
  rel: string,
): DownloadResult {
  const { root } = requireRoot(userId, workspaceId);
  const abs = resolveSafePath(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new NotFoundError("文件不存在");
  }
  if (st.isDirectory()) throw new Error("不能下载目录");
  return {
    stream: createReadStream(abs),
    name: basename(abs),
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
}

export interface UploadResult {
  path: string;
  name: string;
  size: number;
}

export function uploadFile(
  userId: string,
  workspaceId: string,
  parentRel: string | undefined,
  fileName: string,
  data: Buffer,
): UploadResult {
  validateSegment(fileName);
  const { root } = requireRoot(userId, workspaceId);
  const parentAbs = resolveSafePath(root, parentRel);
  if (!isDirectory(parentAbs)) throw new Error("父路径不是目录");
  const childRel = parentRel ? `${parentRel}/${fileName}` : fileName;
  const abs = resolveSafePath(root, childRel);
  ensureDir(dirname(abs));
  writeFileSync(abs, data);
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    /* ignore */
  }
  return { path: relativePath(root, abs), name: fileName, size };
}

// =============================================================================
// Convenience for the chat layer — resolve a workspace's cwd for the agent
// =============================================================================

/**
 * Given a user + optional workspace id, return the directory the agent should
 * treat as its `cwd`. Falls back to the user's default workspace so every
 * conversation has a writable home.
 */
export function resolveAgentCwd(userId: string, workspaceId?: string | null): {
  cwd: string;
  workspace: WorkspaceRow;
  /** True when the requested workspace was a sandbox and we fell back. */
  fellBack?: boolean;
} {
  if (workspaceId) {
    const row = getWorkspace(userId, workspaceId);
    if (row) {
      // Sandbox has no real backend yet — fall back to DemoProject so the
      // agent still has a writable cwd, and flag it so the caller can warn.
      if (row.environment === "sandbox") {
        logger.warn(
          `Sandbox workspace ${row.id} requested but unsupported; falling back to DemoProject`,
        );
        const demo = getOrCreateDemoProject(userId);
        ensureDir(demo.path);
        return { cwd: demo.path, workspace: demo, fellBack: true };
      }
      ensureDir(row.path);
      return { cwd: row.path, workspace: row };
    }
  }
  const def = getOrCreateDemoProject(userId);
  ensureDir(def.path);
  return { cwd: def.path, workspace: def };
}

/** Ensure a thread's outputs directory exists and return its path. */
export function ensureThreadOutputs(
  userId: string,
  workspaceId: string,
  threadId: string,
): string {
  const dir = threadOutputsDir(userId, workspaceId, threadId);
  ensureDir(dir);
  return dir;
}
