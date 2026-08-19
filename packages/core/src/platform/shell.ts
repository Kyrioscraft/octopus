/**
 * Shell resolution for Windows (opencode-style).
 *
 * The deepagents SDK's `LocalShellBackend.execute()` spawns commands with
 * `shell: true`, which resolves to cmd.exe on Windows — no Unix syntax, no
 * pipes like `grep | head`. To let the model use efficient bash search
 * commands (as ZCode does), we locate a Git Bash executable and run commands
 * through `bash -c` instead (see BashShellBackend in agent.ts).
 *
 * Detection order (ported from opencode `packages/core/src/shell.ts`):
 *   1. `OCTOPUS_GIT_BASH_PATH` env var (explicit override)
 *   2. `git` on PATH → derive `<git>\..\..\bin\bash.exe`
 *      (C:\Program Files\Git\cmd\git.exe → C:\Program Files\Git\bin\bash.exe)
 *   3. `bash` on PATH
 *   4. Common install locations
 * Returns undefined when no bash is available — callers fall back to the
 * default system shell (cmd.exe) and adjust the prompt guidance accordingly.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "../logging.js";

const logger = getLogger("shell");

/** Locate `name` on PATH (Windows PATHEXT-aware). Returns the resolved path or undefined. */
function which(name: string): string | undefined {
  const exe = process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(name) ? `${name}.exe` : name;
  const result = spawnSync("where", [exe], { encoding: "utf-8", windowsHide: true });
  if (result.status !== 0 || !result.stdout) return undefined;
  const first = result.stdout.split("\n")[0]?.trim();
  return first || undefined;
}

/** Common Git Bash install locations, used when git/bash are not on PATH. */
const COMMON_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
];

let cachedBash: string | undefined | null | undefined;

/**
 * Resolve a bash executable on Windows (module-level cached).
 * Returns undefined on non-Windows platforms and when no bash is found.
 */
export function resolveBash(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (cachedBash !== undefined) return cachedBash ?? undefined;

  let found: string | undefined;
  // 1. Explicit env override
  if (process.env.OCTOPUS_GIT_BASH_PATH) {
    const p = process.env.OCTOPUS_GIT_BASH_PATH;
    try {
      if (statSync(p).isFile()) found = p;
    } catch {
      logger.warn(`OCTOPUS_GIT_BASH_PATH points to a missing file: ${p}`);
    }
  }
  // 2. git on PATH → sibling bash.exe (opencode's gitbash() trick)
  if (!found) {
    const git = which("git");
    if (git) {
      const candidate = join(dirname(dirname(dirname(git))), "bin", "bash.exe");
      try {
        if (statSync(candidate).isFile()) found = candidate;
      } catch {
        // not there — fall through
      }
    }
  }
  // 3. bash on PATH
  if (!found) found = which("bash");
  // 4. Common install locations
  if (!found) {
    for (const p of COMMON_GIT_BASH_PATHS) {
      try {
        if (statSync(p).isFile()) {
          found = p;
          break;
        }
      } catch {
        // continue
      }
    }
  }

  cachedBash = found ?? null;
  if (found) {
    logger.info(`Shell: using bash at ${found} for execute commands`);
  } else {
    logger.warn("Shell: no bash found on Windows — execute falls back to cmd.exe");
  }
  return found;
}
