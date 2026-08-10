// =============================================================================
// External hook dispatch system.
// Equivalent to Python tui.hooks.
//
// Dispatches tool integration hooks via JSON payloads on subprocess stdin.
// Loads config from ~/.deepagents/hooks.json.
// =============================================================================

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Hook config
// =============================================================================

export interface HookConfig {
  /** Hook event name → list of commands. */
  [event: string]: HookCommand[];
}

export interface HookCommand {
  /** Shell command to execute. */
  command: string;
  /** Working directory for the command. */
  cwd?: string;
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** Whether to wait for the command to complete. */
  wait?: boolean;
}

// =============================================================================
// Config loading
// =============================================================================

const HOOKS_PATH = join(homedir(), ".deepagents", "hooks.json");

let _hooksConfig: HookConfig | null = null;

/**
 * Load the hooks configuration from ~/.deepagents/hooks.json.
 */
export function loadHooksConfig(): HookConfig {
  if (_hooksConfig) return _hooksConfig;

  try {
    const raw = readFileSync(HOOKS_PATH, "utf-8");
    _hooksConfig = JSON.parse(raw) as HookConfig;
  } catch {
    _hooksConfig = {};
  }

  return _hooksConfig;
}

/**
 * Clear cached hooks config (for testing).
 */
export function clearHooksCache(): void {
  _hooksConfig = null;
}

// =============================================================================
// Dispatch
// =============================================================================

/**
 * Dispatch a hook event asynchronously.
 * Equivalent to Python `dispatch_hook()`.
 *
 * Runs matching commands concurrently. Fire-and-forget — errors are logged
 * but never propagated.
 */
export function dispatchHook(
  event: string,
  payload: Record<string, unknown>,
): void {
  const config = loadHooksConfig();
  const commands = config[event];
  if (!commands || commands.length === 0) return;

  const payloadJson = JSON.stringify(payload);

  for (const cmd of commands) {
    try {
      const child = spawn(cmd.command, [], {
        shell: true,
        cwd: cmd.cwd ?? process.cwd(),
        env: { ...process.env, ...(cmd.env ?? {}) },
        stdio: ["pipe", "inherit", "inherit"],
      });

      // Write payload to stdin
      child.stdin?.write(payloadJson);
      child.stdin?.end();

      // If wait is not explicitly true, fire-and-forget
      if (!cmd.wait) {
        child.unref();
      }
    } catch {
      // Hook failures are silently ignored
    }
  }
}

/**
 * Dispatch a hook event as a fire-and-forget background task.
 * Equivalent to Python `dispatch_hook_fire_and_forget()`.
 */
export function dispatchHookFireAndForget(
  event: string,
  payload: Record<string, unknown>,
): void {
  // In Node.js, spawn is inherently async, so this is equivalent
  dispatchHook(event, payload);
}
