/**
 * Utilities for project root detection and project-specific configuration.
 *
 * Equivalent to Python `cortex.project_utils` + `cortex._git` (git root discovery).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep, isAbsolute } from "node:path";
import { getLogger } from "../logging.js";

const logger = getLogger("project.utils");

// =============================================================================
// Git root discovery — equivalent to Python `cortex._git.find_git_root()`.
// =============================================================================

const GIT_DIR_POINTER_PREFIX = "gitdir: ";

/**
 * Resolve a `.git` file containing a `gitdir:` pointer (worktree-style).
 *
 * Returns the resolved git directory path, or `null` if the file is not
 * a valid gitdir pointer.
 */
function _parseGitDirPointer(gitEntry: string): string | null {
  try {
    const raw = readFileSync(gitEntry, "utf-8").trim();
    if (!raw.startsWith(GIT_DIR_POINTER_PREFIX)) return null;
    const pointer = raw.slice(GIT_DIR_POINTER_PREFIX.length).trim();
    if (!pointer) return null;

    let gitDir = pointer;
    if (!isAbsolute(gitDir)) {
      // Relative to the parent directory of the .git file
      const parentDir = gitEntry.slice(0, gitEntry.lastIndexOf(sep));
      gitDir = resolve(parentDir, pointer);
    }
    // Check if the resolved directory exists
    try {
      const st = statSync(gitDir);
      if (st.isDirectory()) return gitDir;
    } catch {
      return null;
    }
    return null;
  } catch {
    logger.debug(`Failed to read gitdir pointer from ${gitEntry}`);
    return null;
  }
}

/**
 * Locate the repository root for a path by walking up directories
 * looking for `.git`.
 *
 * @param startPath  Directory or file path inside a repository.
 * @returns The repository root path, or `null` when no repository found.
 *
 * Equivalent to Python `find_git_root()`.
 */
function findGitRoot(startPath: string): string | null {
  // Normalize and resolve
  let current: string;
  try {
    current = resolve(startPath.replace(/^~/, homedir()));
  } catch {
    return null;
  }

  // If it's a file, start from its parent
  try {
    if (!statSync(current).isDirectory()) {
      const lastSep = current.lastIndexOf(sep);
      if (lastSep > 0) current = current.slice(0, lastSep);
    }
  } catch {
    return null;
  }

  // Walk up directory tree
  const root = current.slice(0, current.indexOf(sep) + 1) || sep; // filesystem root
  while (current.length >= root.length) {
    const gitEntry = join(current, ".git");
    try {
      const st = statSync(gitEntry);
      if (st.isDirectory()) {
        return current;
      }
      if (st.isFile()) {
        const gitDir = _parseGitDirPointer(gitEntry);
        if (gitDir) return current;
        return null; // Invalid gitdir pointer — stop here
      }
    } catch {
      // .git doesn't exist or is unreadable — continue walking up
    }

    // Move to parent
    const parent = current.slice(0, current.lastIndexOf(sep));
    if (parent === current || parent.length === 0) break;
    current = parent;
  }

  return null;
}

// =============================================================================
// findProjectRoot — public API.
// Equivalent to Python `find_project_root()`.
// =============================================================================

/**
 * Find the project root by looking for git metadata.
 *
 * @param startPath  Directory to start searching from. Defaults to CWD.
 * @returns Path to the project root if found, null otherwise.
 */
export function findProjectRoot(startPath?: string): string | null {
  const current = resolve(startPath ?? process.cwd());
  return findGitRoot(current);
}

// =============================================================================
// ProjectContext — equivalent to Python `ProjectContext`.
// =============================================================================

/**
 * Explicit user/project path context for project-sensitive behavior.
 *
 * Equivalent to Python `ProjectContext` dataclass.
 */
export class ProjectContext {
  /** Authoritative working directory from the app invocation. */
  readonly userCwd: string;

  /** Resolved project root for `userCwd`, if one exists. */
  readonly projectRoot: string | null;

  constructor(userCwd: string, projectRoot?: string | null) {
    // Resolve and validate
    const resolved = resolve(userCwd.replace(/^~/, homedir()));
    if (!isAbsolute(resolved)) {
      throw new Error(`userCwd must be absolute, got ${userCwd}`);
    }
    this.userCwd = resolved;
    this.projectRoot = projectRoot ?? findGitRoot(resolved);
  }

  /**
   * Build a ProjectContext from an explicit user working directory.
   *
   * Equivalent to Python `ProjectContext.from_user_cwd()`.
   */
  static fromUserCwd(userCwd: string): ProjectContext {
    return new ProjectContext(userCwd);
  }

  /**
   * Resolve a path relative to the user working directory.
   *
   * @returns Absolute resolved path.
   *
   * Equivalent to Python `ProjectContext.resolve_user_path()`.
   */
  resolveUserPath(relativePath: string): string {
    const expanded = relativePath.replace(/^~/, homedir());
    if (isAbsolute(expanded)) return resolve(expanded);
    return resolve(this.userCwd, expanded);
  }

  /**
   * Return the ~/.deepagents directory path.
   */
  get userDeepagentsDir(): string {
    return join(homedir(), ".deepagents");
  }

  /**
   * Return the project `.deepagents/agents` directory, if available.
   */
  get projectAgentsDir(): string | null {
    if (!this.projectRoot) return null;
    return join(this.projectRoot, ".deepagents", "agents");
  }

  /**
   * Return the project `.deepagents/skills` directory, if available.
   */
  get projectSkillsDir(): string | null {
    if (!this.projectRoot) return null;
    return join(this.projectRoot, ".deepagents", "skills");
  }

  /**
   * Return the project `.agents/skills` directory, if available.
   */
  get projectAgentSkillsDir(): string | null {
    if (!this.projectRoot) return null;
    return join(this.projectRoot, ".agents", "skills");
  }

  /**
   * Find project-level AGENTS.md file(s).
   *
   * Checks `.deepagents/AGENTS.md` and `AGENTS.md` in the project root.
   * Returns the paths that exist on disk.
   *
   * Equivalent to Python `ProjectContext.project_agent_md_paths()`.
   */
  projectAgentMdPaths(): string[] {
    if (!this.projectRoot) return [];
    const candidates = [
      join(this.projectRoot, ".deepagents", "AGENTS.md"),
      join(this.projectRoot, "AGENTS.md"),
    ];
    return candidates.filter((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
  }
}

// =============================================================================
// getServerProjectContext — equivalent to Python `get_server_project_context()`.
// =============================================================================

const SERVER_ENV_PREFIX = "DEEPAGENTS_CODE_";

/**
 * Read the server project context from environment transport data.
 *
 * @param env  Environment mapping to read from. Defaults to `process.env`.
 * @returns Reconstructed project context, or `null` if no server context exists.
 *
 * Equivalent to Python `get_server_project_context()`.
 */
export function getServerProjectContext(
  env?: Record<string, string | undefined>,
): ProjectContext | null {
  const environment = env ?? (process.env as Record<string, string | undefined>);
  const rawCwd = environment[`${SERVER_ENV_PREFIX}SERVER_CWD`]
    ?? environment[`${SERVER_ENV_PREFIX}CWD`];

  if (!rawCwd) return null;

  try {
    const userCwd = resolve(rawCwd.replace(/^~/, homedir()));
    const rawProjectRoot = environment[`${SERVER_ENV_PREFIX}PROJECT_ROOT`];
    const projectRoot = rawProjectRoot
      ? resolve(rawProjectRoot.replace(/^~/, homedir()))
      : findGitRoot(userCwd);

    return new ProjectContext(userCwd, projectRoot);
  } catch {
    logger.warn(`Could not resolve server project context from CWD=${rawCwd}`);
    return null;
  }
}
