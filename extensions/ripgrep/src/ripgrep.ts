/**
 * Bundled ripgrep binary resolver + spawn wrapper.
 *
 * The ripgrep binary ships inside this package's dist/binaries/<platform>-<arch>/
 * directory (fetched at build time by scripts/fetch-ripgrep.cjs). At runtime we
 * resolve it via __dirname (which points into dist/ after tsc), then spawnSync
 * it for each search — ripgrep is stateless and short-lived, so no daemon.
 *
 * Resolution mirrors @octopus/core's built_in_skills pattern
 * (fileURLToPath(import.meta.url) → dirname → join), which is the established
 * ESM convention across this repo for locating package-bundled resources.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { getLogger } from "@octopus/core";

const logger = getLogger("extension.ripgrep");

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Platform key matching the binary directory layout, e.g. "win32-x64",
 * "linux-x64", "darwin-arm64". Same convention as @vscode/ripgrep /
 * @node-rs/* platform packages.
 */
function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Absolute path to the bundled ripgrep executable for the current platform.
 */
export function resolveRipgrepPath(): string {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  return join(__dirname, "binaries", platformKey(), exe);
}

let cachedPath: string | null | undefined;

/**
 * Return the ripgrep path if the binary is present, otherwise null.
 * The result is cached after the first check. A missing binary is logged
 * once as a warning (common cause: build script didn't run for this platform).
 */
export function getRipgrepPath(): string | null {
  if (cachedPath !== undefined) return cachedPath;
  const p = resolveRipgrepPath();
  if (!existsSync(p)) {
    logger.warn(
      `Bundled ripgrep not found at ${p} — run "pnpm --filter @octopus/extension-ripgrep build" to fetch it`,
    );
    cachedPath = null;
  } else {
    cachedPath = p;
  }
  return cachedPath;
}

export interface RipgrepResult {
  /** rg exit code: 0 = matches found, 1 = no matches, 2 = error. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run ripgrep synchronously with the given args.
 *
 * spawnSync is used (not async spawn) because ripgrep searches are fast and
 * short-lived; the tool handler is already async at the LangChain layer so
 * there's no event-loop blocking concern that matters here. A 30s timeout
 * caps pathological searches.
 */
export function runRipgrep(
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): RipgrepResult {
  const rgPath = getRipgrepPath();
  if (!rgPath) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: "ripgrep binary not available",
      timedOut: false,
    };
  }
  const result = spawnSync(rgPath, args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10MB cap — matches tool-level truncation
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.signal === "SIGTERM" || result.signal === "SIGKILL",
  };
}
