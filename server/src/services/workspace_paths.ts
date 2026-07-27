/**
 * Workspace path helpers + traversal protection.
 *
 * Workspaces are real directories on the host filesystem under
 * `<workspacesRoot>/<userId>/<workspaceId>/`. The agent runs with one such
 * directory as its `cwd`, so file tool calls land inside it. This module owns
 * the path layout and the security checks that keep every resolved path
 * contained within a workspace root.
 *
 * Equivalent in spirit to yuxi's `agents/backends/sandbox/paths.py` +
 * `utils/paths.py`, adapted for octopus's DB-tracked workspace model.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { getLogger } from "@octopus/core";

const logger = getLogger("server.workspace.paths");

// =============================================================================
// Root layout
// =============================================================================

/** Configurable via env so deployments can point workspaces elsewhere. */
export function workspacesRoot(): string {
  return process.env["OCTOPUS_WORKSPACES_DIR"]?.trim() || "data/workspaces";
}

/** Directory holding all of a user's workspaces: `<root>/<userId>`. */
export function userWorkspacesDir(userId: string): string {
  return join(workspacesRoot(), userId);
}

/** Directory of a single workspace: `<root>/<userId>/<workspaceId>`. */
export function workspaceDir(userId: string, workspaceId: string): string {
  return join(userWorkspacesDir(userId), workspaceId);
}

/**
 * Per-thread outputs directory inside a workspace. Agent-produced files
 * written under the workspace during a conversation are conventionally placed
 * here so the conversation file drawer can find them. The directory is created
 * on demand.
 */
export function threadOutputsDir(
  userId: string,
  workspaceId: string,
  threadId: string,
): string {
  return join(workspaceDir(userId, workspaceId), "outputs", threadId);
}

// =============================================================================
// Browsable roots — the host directories the directory-browser starts from and
// may bind as local workspace paths.
//
// By default the browser can see the whole filesystem (like the OS file
// explorer): on Windows it lists every drive letter; on POSIX it starts at "/".
// Deployments that want to restrict visibility can set
// OCTOPUS_WORKSPACE_BROWSABLE_ROOTS to a comma-separated list of absolute
// paths, in which case browsing + binding are confined to those roots.
// =============================================================================

import { homedir } from "node:os";

/** The filesystem roots (Windows drive letters, or "/" on POSIX). */
function filesystemRoots(): string[] {
  if (process.platform === "win32") {
    // Enumerate existing drive letters (C:\, D:\, ...).
    const roots: string[] = [];
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const drive = `${letter}:\\`;
      try {
        if (existsSync(drive) && lstatSync(drive).isDirectory()) roots.push(drive);
      } catch {
        /* drive not accessible */
      }
    }
    return roots.length > 0 ? roots : ["C:\\"];
  }
  return ["/"];
}

/**
 * Resolved, de-duplicated list of browsable roots (absolute). When
 * OCTOPUS_WORKSPACE_BROWSABLE_ROOTS is unset, this is the full set of
 * filesystem roots (unrestricted, like the OS file explorer).
 */
export function browsableRoots(): string[] {
  const raw = process.env["OCTOPUS_WORKSPACE_BROWSABLE_ROOTS"]?.trim();
  if (!raw) return filesystemRoots();
  // Explicit restriction: normalize + de-duplicate the configured roots.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const abs = resolve(c.replace(/^~/, homedir()));
      if (!isAbsolute(abs) || seen.has(abs)) continue;
      if (!existsSync(abs) || !lstatSync(abs).isDirectory()) continue;
      seen.add(abs);
      out.push(abs);
    } catch {
      /* ignore invalid entries */
    }
  }
  return out;
}

/**
 * Whether `absPath` is browsable/bindable. When unrestricted (no env config),
 * everything is allowed (the whole filesystem). When restricted, the path must
 * be contained within one of the configured roots.
 */
export function isWithinBrowsableRoots(absPath: string): boolean {
  const restricted = !!process.env["OCTOPUS_WORKSPACE_BROWSABLE_ROOTS"]?.trim();
  if (!restricted) return true; // whole filesystem visible by default
  const roots = browsableRoots();
  if (roots.length === 0) return false;
  const target = resolve(absPath);
  return roots.some((root) => {
    if (target === root) return true;
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

// =============================================================================
// Path safety
// =============================================================================

/** Reject Windows-unsafe / path-traversal characters in a single segment. */
const FORBIDDEN_SEGMENT = /[<>:"|?*\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export class PathTraversalError extends Error {
  constructor(message = "路径不合法") {
    super(message);
    this.name = "PathTraversalError";
  }
}

/** Validate a single path segment (file/dir name). Throws on invalid input. */
export function validateSegment(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new PathTraversalError("名称不能为空或为 . / ..");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new PathTraversalError("名称不能包含路径分隔符");
  }
  if (FORBIDDEN_SEGMENT.test(name)) {
    throw new PathTraversalError("名称包含非法字符");
  }
  if (WIN_RESERVED.test(name)) {
    throw new PathTraversalError("名称使用了系统保留字");
  }
}

/**
 * Resolve `rel` against the workspace `root` and guarantee the result stays
 * inside `root` (after symlink resolution). Rejects `..`, absolute paths that
 * escape the root, and broken symlinks.
 *
 * @param root  Absolute workspace directory (trusted).
 * @param rel   User-supplied relative path (untrusted). May be "" for the root.
 * @returns     The absolute, contained path.
 *
 * Equivalent in spirit to yuxi's `resolve_virtual_path` containment checks.
 */
export function resolveSafePath(root: string, rel: string | undefined): string {
  const cleaned = (rel ?? "").trim().replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
  if (cleaned.includes("..")) {
    throw new PathTraversalError("路径不能包含 ..");
  }

  // join() normalizes separators; resolve() makes it absolute.
  const candidate = resolve(join(root, cleaned));

  // Containment check via the relative path (must not climb above root).
  const relFromRoot = relative(root, candidate);
  if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    throw new PathTraversalError("路径越出工作区根目录");
  }

  // Reject symlinks pointing outside the root (if the entry already exists).
  if (existsSync(candidate)) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      throw new PathTraversalError("无法解析路径 (可能是断开的符号链接)");
    }
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    const relFromReal = relative(realRoot, real);
    if (relFromReal.startsWith("..") || isAbsolute(relFromReal)) {
      logger.warn(`Symlink escapes root: ${candidate} -> ${real}`);
      throw new PathTraversalError("路径指向工作区之外");
    }
  }

  return candidate;
}

/** Recursively create a directory (no error if it already exists). */
export function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!isAbsolute(dir) || !existsSync(dir)) {
    mkdirSync(path, { recursive: true });
    return;
  }
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

/** Whether a path is itself a directory (false on missing/broken). */
export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The forward-slash relative path of a file inside the workspace root,
 * suitable for returning to the client. Uses `/` regardless of host OS so the
 * frontend tree logic is platform-agnostic.
 */
export function relativePath(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel ? rel.split(sep).join("/") : "";
}
