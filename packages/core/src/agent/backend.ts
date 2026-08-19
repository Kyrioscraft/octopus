/**
 * Sandbox backend construction — extracted from agent/graph.ts.
 *
 * Owns the backend-selection logic: sandbox (LangSmith) vs local shell
 * (BashShellBackend) vs plain FilesystemBackend, plus the CompositeBackend
 * temp-directory routing for /large_tool_results/ and
 * /conversation_history/.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CompositeBackend, FilesystemBackend, LocalShellBackend, LangSmithSandbox } from "deepagents";
import type { ServerConfig } from "../config/index.js";
import { getSandboxConfig, resolveSandboxApiKey, sandboxHasCredentials } from "../providers/index.js";
import { getLogger } from "../logging.js";
import { resolveBash } from "../shell.js";

const logger = getLogger("agent.backend");

// =============================================================================
// BashShellBackend — Windows bash execution (opencode-style).
//
// The SDK's LocalShellBackend spawns with `shell: true`, which resolves to
// cmd.exe on Windows. This subclass routes commands through Git Bash
// (`bash -c <command>`) when one is available (resolveBash(), see shell.ts),
// so the model can use Unix syntax (`grep -rn ... | head -20`, `find`) the
// way ZCode does. Without bash it falls back to the SDK's cmd.exe behavior
// — the shell guidance prompt is branched to match (see
// filesystem_policy_middleware.ts).
//
// The SDK class keeps env/timeout in `#private` fields (inaccessible to
// subclasses), so we hold our own copies of the constructor options.
// =============================================================================

export class BashShellBackend extends LocalShellBackend {
  #timeout: number;
  #maxOutputBytes: number;
  #env: Record<string, string>;

  constructor(options: {
    rootDir: string;
    timeout?: number;
    maxOutputBytes?: number;
    env?: Record<string, string>;
    inheritEnv?: boolean;
  }) {
    super(options);
    this.#timeout = options.timeout ?? 120;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1e5;
    if (options.inheritEnv) {
      this.#env = { ...process.env } as Record<string, string>;
      if (options.env) Object.assign(this.#env, options.env);
    } else {
      this.#env = options.env ?? {};
    }
  }

  async execute(command: string): Promise<{ output: string; exitCode: number; truncated: boolean }> {
    if (!command || typeof command !== "string") {
      return { output: "Error: Command must be a non-empty string.", exitCode: 1, truncated: false };
    }
    const bash = process.platform === "win32" ? resolveBash() : undefined;
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = bash
        ? spawn(bash, ["-c", command], { env: this.#env, cwd: this.cwd })
        : spawn(command, { shell: true, env: this.#env, cwd: this.cwd });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.#timeout * 1e3);
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ output: `Error executing command: ${err.message}`, exitCode: 1, truncated: false });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut || signal === "SIGTERM") {
          resolve({
            output: `Error: Command timed out after ${this.#timeout.toFixed(1)} seconds.`,
            exitCode: 124,
            truncated: false,
          });
          return;
        }
        const outputParts = [];
        if (stdout) outputParts.push(stdout);
        if (stderr) {
          const stderrLines = stderr.trim().split("\n");
          outputParts.push(...stderrLines.map((line) => `[stderr] ${line}`));
        }
        let output = outputParts.join("\n");
        const truncated = Buffer.byteLength(output, "utf8") > this.#maxOutputBytes;
        if (truncated) {
          output = Buffer.from(output, "utf8").subarray(0, this.#maxOutputBytes).toString("utf8");
          output += `\n[output truncated — exceeded ${this.#maxOutputBytes} bytes]`;
        }
        resolve({ output, exitCode: code ?? 1, truncated });
      });
    });
  }
}

/**
 * Build the primary backend (sandbox or local) wrapped in a CompositeBackend
 * with temp-directory routes for /large_tool_results/ and
 * /conversation_history/.
 *
 * Matching Python: local mode uses CompositeBackend with routes for
 * /large_tool_results/ and /conversation_history/ to temp directories.
 *
 * Workspace environment drives the primary backend: "sandbox" tries to build
 * a LangSmith sandbox (falls back to local if unconfigured/fails); otherwise
 * a local host backend rooted at `cwd`.
 */
export async function buildBackend(
  config: ServerConfig,
  options: {
    cwd: string;
    workspace?: { environment?: "local" | "sandbox" };
    extraPathDirs?: string[];
  },
): Promise<any> {
  const { cwd } = options;

  let backend: any;
  const useSandbox = options.workspace?.environment === "sandbox";
  let sandboxBuilt = false;
  if (useSandbox) {
    try {
      const sbCfg = getSandboxConfig();
      const apiKey = resolveSandboxApiKey(sbCfg);
      if (sbCfg.enabled !== false && sandboxHasCredentials(sbCfg)) {
        logger.info("Building LangSmith sandbox backend");
        backend = await LangSmithSandbox.create({
          ...(apiKey ? { apiKey } : {}),
          ...(sbCfg.template_name ? { templateName: sbCfg.template_name } : {}),
          ...(sbCfg.snapshot_id ? { snapshotId: sbCfg.snapshot_id } : {}),
        });
        sandboxBuilt = true;
      } else {
        logger.warn("Sandbox workspace requested but sandbox not configured; falling back to local");
      }
    } catch (err) {
      logger.exception("Failed to build sandbox backend; falling back to local", err as Error);
    }
  }
  if (!sandboxBuilt) {
    if (config.enableShell) {
      // Prepend the bundled ripgrep binary directory (when provided by the
      // server) to PATH so bare `rg` invocations in execute commands work
      // even when ripgrep is not installed on the host.
      const shellEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
      const rgDir = options.extraPathDirs?.find((d) => d.includes("ripgrep"));
      if (rgDir && existsSync(rgDir)) {
        shellEnv.PATH = `${rgDir};${shellEnv.PATH ?? ""}`;
        logger.info(`Shell PATH: prepended bundled ripgrep dir ${rgDir}`);
      }
      backend = new BashShellBackend({
        rootDir: cwd,
        inheritEnv: true,
        env: shellEnv,
      });
    } else {
      backend = new FilesystemBackend({ rootDir: cwd, virtualMode: false });
    }
  }

  const largeResultsBackend = new FilesystemBackend({
    rootDir: mkdtempSync(join(tmpdir(), "deepagents_large_results_")),
    virtualMode: true,
  });
  const conversationHistoryBackend = new FilesystemBackend({
    rootDir: mkdtempSync(join(tmpdir(), "deepagents_conversation_history_")),
    virtualMode: true,
  });

  return new CompositeBackend(backend, {
    "/large_tool_results/": largeResultsBackend,
    "/conversation_history/": conversationHistoryBackend,
  });
}
