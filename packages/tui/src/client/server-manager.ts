/**
 * Server lifecycle manager — spawns the Octopus HTTP server as a child process
 * when the TUI starts, redirects all its output to a log file (so it never
 * corrupts the Ink render region), waits for it to become healthy, and kills
 * it when the TUI exits.
 *
 * Why a child process (not an in-process import):
 *   - Architecture boundary: `tui` must not import `@octopus/server` (it is
 *     not a dependency, and AGENTS.md forbids web/tui → server coupling).
 *     The TUI talks to the server exclusively through `OctopusClient`.
 *   - Process isolation: a server crash or uncaught error cannot take down
 *     the TUI, and the two have independent stdin/stdout/stderr.
 *   - Clean logs: the server's `getLogger()` writes to its stderr by default
 *     (see core/src/logging.ts). By handing the child a file as its fd 1/2,
 *     every server log line lands in `~/.deepagents/logs/server.log` and the
 *     TUI's terminal stays pristine.
 *
 * Lifecycle:
 *   1. `probe()` — is something already listening on the server URL? If so,
 *      reuse it (we never kill a server we didn't start).
 *   2. `start()` — spawn `node server/dist/main.js`, wait for
 *      `/api/system/health` to respond, return.
 *   3. `stop()` — SIGTERM, then SIGKILL after a grace period. Only called for
 *      a server this manager actually started.
 *
 * The probe intentionally targets the auth-agnostic, DB-free
 * `/api/system/health` endpoint rather than `/api/auth/check-first-run`. The
 * TUI boots straight into an anonymous session (the server's chat routes use
 * `getOptionalUser`, which falls back to a `dev-user`), so the readiness gate
 * should not depend on auth or first-run state — only on whether something is
 * listening and answering HTTP.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getLogger } from "../utils/logging.js";

const logger = getLogger("tui.server-manager");

// =============================================================================
// Constants
// =============================================================================

const LOG_DIR = join(homedir(), ".deepagents", "logs");
const SERVER_LOG_FILE = join(LOG_DIR, "server.log");

/** How long to wait for the server to become healthy after spawn (ms). */
const HEALTH_TIMEOUT_MS = 15_000;
/** Interval between health probes while waiting for startup (ms). */
const HEALTH_POLL_INTERVAL_MS = 200;
/** Grace period after SIGTERM before escalating to SIGKILL (ms). */
const SHUTDOWN_GRACE_MS = 3_000;

// =============================================================================
// Options
// =============================================================================

export interface ServerManagerOptions {
  /** Full server URL, e.g. "http://127.0.0.1:9876". */
  serverUrl: string;
  /** When false (--no-auto-server), skip spawning and only probe. */
  autoStart: boolean;
}

export interface StartResult {
  /** True if a healthy server is reachable when this returns. */
  ok: boolean;
  /** True if an already-running server was reused (not spawned by us). */
  reused: boolean;
  /** Human-readable error message when `ok` is false. */
  error?: string;
}

// =============================================================================
// Path resolution
// =============================================================================

/**
	 * resolveServerScript — this module now runs as
	 * `packages/tui/dist/client/server-manager.js`; the repo root is four
	 * levels up (`tui/dist/client` → `tui/dist` → `tui` → `packages` → repo root),
	 * and the server entry is `packages/server/dist/main.js` under that root.
	 */
	function resolveServerScript(): string {
	  // `import.meta.url` is the canonical ESM way to get the current module URL.
	  const here = dirname(fileURLToPath(import.meta.url));
	  const repoRoot = join(here, "..", "..", "..", "..");
  return join(repoRoot, "packages", "server", "dist", "main.js");
}

/** Extract the TCP port from a server URL string (falls back to 9876). */
function portFromUrl(serverUrl: string): number {
  try {
    const port = new URL(serverUrl).port;
    return port ? parseInt(port, 10) : 9876;
  } catch {
    return 9876;
  }
}

// =============================================================================
// ServerManager
// =============================================================================

export class ServerManager {
  readonly #serverUrl: string;
  readonly #autoStart: boolean;
  #child: ChildProcess | null = null;
  /** Numeric fds for the child's redirected stdout/stderr (closed on stop). */
  #logFdOut: number | null = null;
  #logFdErr: number | null = null;
  /** True once we've spawned the child (drives whether `stop()` kills). */
  #spawned = false;

  constructor(opts: ServerManagerOptions) {
    this.#serverUrl = opts.serverUrl;
    this.#autoStart = opts.autoStart;
  }

  // ---------------------------------------------------------------------------
  // Health probe
  // ---------------------------------------------------------------------------

  /**
   * Lightweight reachability check against the server. Uses a raw `fetch`
   * with a short timeout rather than `TuiClient` to avoid pulling client
   * dependencies into this bootstrap module. Any HTTP response (even 4xx)
   * counts as "alive" — we only care that something is listening.
   */
  async #probe(timeoutMs = 800): Promise<boolean> {
    const url = this.#serverUrl.replace(/\/$/, "") + "/api/system/health";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      // Any response (2xx/4xx) means the server is up. Network errors throw.
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  async start(): Promise<StartResult> {
    // 1. If something is already listening, reuse it — never spawn a second
    //    server on the same port (that would EADDRINUSE and fail).
    if (await this.#probe()) {
      logger.info("Reusing already-running server at " + this.#serverUrl);
      return { ok: true, reused: true };
    }

    if (!this.#autoStart) {
      return {
        ok: false,
        reused: false,
        error: `No server reachable at ${this.#serverUrl}, and --no-auto-server was set.`,
      };
    }

    // 2. Resolve and validate the server script before spawning so we can
    //    give a clear actionable error instead of a Node ENOENT stack.
    const script = resolveServerScript();
    if (!existsSync(script)) {
      return {
        ok: false,
        reused: false,
        error: `Server entry not found: ${script}\n` +
               "Build it first:  cd server && npm run build",
      };
    }

    // 3. Prepare the log file. We open raw file descriptors and pass them
    //    directly as the child's stdio targets — spawn's stdio entries must
    //    be a string ("pipe"/"ignore"/"inherit") or a number fd; a freshly
    //    created fs.WriteStream has fd===null (lazily opened) and spawn
    //    rejects it with ERR_INVALID_ARG_VALUE. openSync gives us a ready fd.
    //    Both stdout and stderr point at the same server.log so every line
    //    the server prints (it logs via stderr) lands in one place and never
    //    reaches the terminal hosting the TUI.
    mkdirSync(LOG_DIR, { recursive: true });
    this.#logFdOut = openSync(SERVER_LOG_FILE, "a");
    this.#logFdErr = openSync(SERVER_LOG_FILE, "a");
    const port = portFromUrl(this.#serverUrl);

    // 4. Spawn. env is inherited (so the server's `loadDotEnv()` + API keys
    //    behave exactly as if it were launched by hand) plus the port hint.
    this.#child = spawn(process.execPath, [script], {
      stdio: ["ignore", this.#logFdOut, this.#logFdErr],
      env: { ...process.env, OCTOPUS_WEB_PORT: String(port) },
      windowsHide: true,
      detached: false,
    });
    this.#spawned = true;

    // Surface child exit/failure to the log so a crashed server leaves a
    // breadcrumb in server.log before the TUI notices it's gone.
    this.#child.on("error", (err) => {
      logger.exception("server child process error", err);
    });
    this.#child.on("exit", (code, signal) => {
      logger.info(`server child exited code=${code} signal=${signal}`);
    });

    logger.info(`Spawned server (pid=${this.#child.pid}) → ${SERVER_LOG_FILE}`);

    // 5. Wait for health. Poll on a short interval; bail with an error if
    //    the child died (e.g. bad env, missing build) or we time out.
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        return {
          ok: false,
          reused: false,
          error: `Server process exited prematurely (code=${this.#child.exitCode}). ` +
                 `Check ${SERVER_LOG_FILE} for details.`,
        };
      }
      if (await this.#probe(500)) {
        logger.info("Server is healthy");
        return { ok: true, reused: false };
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    return {
      ok: false,
      reused: false,
      error: `Server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s. ` +
             `Check ${SERVER_LOG_FILE} for details.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  /**
   * Terminate the server we spawned. No-op if we reused an external server
   * (`#spawned` is false) or never started one.
   *
   * Uses SIGTERM first to let the server clean up (close listeners, flush
   * logs), escalating to SIGKILL only after a grace period.
   */
  async stop(): Promise<void> {
    if (!this.#spawned || !this.#child) {
      this.#closeLogFds();
      return;
    }

    const child = this.#child;
    if (child.exitCode === null && child.signalCode === null) {
      logger.info("Stopping server (SIGTERM)...");
      child.kill("SIGTERM");

      // Wait for graceful exit, then force-kill if still alive.
      const forceDeadline = Date.now() + SHUTDOWN_GRACE_MS;
      while (Date.now() < forceDeadline) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await sleep(100);
      }
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn("Server did not exit after SIGTERM, sending SIGKILL");
        child.kill("SIGKILL");
      }
    }

    this.#closeLogFds();
    this.#child = null;
    this.#spawned = false;
  }

  /** Close the log file descriptors if open (idempotent). */
  #closeLogFds(): void {
    if (this.#logFdOut !== null) {
      try { closeSync(this.#logFdOut); } catch { /* already closed */ }
      this.#logFdOut = null;
    }
    if (this.#logFdErr !== null) {
      try { closeSync(this.#logFdErr); } catch { /* already closed */ }
      this.#logFdErr = null;
    }
  }

  /** Path to the server log file (exposed for diagnostics / `/log`). */
  static get logFilePath(): string {
    return SERVER_LOG_FILE;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
