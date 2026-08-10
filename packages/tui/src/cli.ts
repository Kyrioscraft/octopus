#!/usr/bin/env node
// =============================================================================
// CLI entry point — equivalent to Python tui.main.cli_main()
//
// Parses CLI arguments and dispatches to the appropriate mode:
//   - Interactive TUI mode (default): starts the Ink terminal UI
//   - Non-interactive mode (-n): runs a single prompt and exits
//   - Headless commands: threads, agents, skills, mcp, etc.
// =============================================================================

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { loadDotEnv } from "@octopus/core";
import { initTuiLogging, getLogger } from "./utils/logging.js";

const logger = getLogger("tui.cli");

// Resolve package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

// =============================================================================
// Main CLI program
// =============================================================================

const program = new Command();

program
  .name("oc")
  .description("Octopus AI agent — terminal interface")
  .version(pkg.version, "-v, --version", "Show version number")
  .option("-m, --model <spec>", "Model spec (e.g. openai:deepseek-v4-flash)")
  .option("-p, --prompt <text>", "Initial prompt to send immediately")
  .option("-n, --non-interactive", "Run in non-interactive mode (one-shot)")
  .option("--agent <name>", "Agent identifier to invoke")
  .option("--auto-approve", "Auto-approve all tool calls")
  .option("--enable-shell", "Enable shell execution tool")
  .option("--no-shell", "Disable shell execution tool")
  .option("--server <url>", "Server URL (default: http://127.0.0.1:9876)")
  .option("--no-auto-server", "Don't auto-start the server; connect to an existing one")
  .option("--token <jwt>", "JWT access token for authentication")
  .option("--debug", "Enable debug logging to ~/.deepagents/logs/tui.log (stackable for verbose)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.nonInteractive && !opts.prompt) {
      console.error("Error: --non-interactive (-n) requires --prompt (-p)");
      process.exit(2);
    }
  })
  .action(async (opts) => {
    if (opts.nonInteractive) {
      await runNonInteractive(opts);
    } else {
      await runInteractive(opts);
    }
  });

// =============================================================================
// Subcommands (headless modes)
// =============================================================================

program
  .command("threads")
  .description("List, resume, or delete chat threads")
  .option("--server <url>", "Server URL")
  .option("--token <jwt>", "JWT access token")
  .action(async (_opts) => {
    // TODO: Phase 2 — wire up thread listing via OctopusClient
    console.log("Thread management — coming in Phase 2");
  });

program
  .command("mcp")
  .description("MCP server management")
  .action(async (_opts) => {
    console.log("MCP management — coming in Phase 5");
  });

program
  .command("agents")
  .description("List available agents")
  .action(async () => {
    const { listSubagents } = await import("@octopus/core");
    const agents = listSubagents({});
    for (const agent of agents) {
      console.log(`  ${chalk.cyan(agent.name)} — ${agent.description ?? "(no description)"}`);
    }
  });

program
  .command("skills")
  .description("List available skills")
  .action(async () => {
    const { listSkills } = await import("@octopus/core");
    const skills = listSkills({});
    for (const skill of skills) {
      console.log(`  ${chalk.cyan(skill.name)} — ${skill.description ?? "(no description)"}`);
      console.log(`    ${chalk.dim(skill.path)}`);
    }
  });

// =============================================================================
// Mode runners
// =============================================================================

interface CliOpts {
  model?: string;
  prompt?: string;
  agent?: string;
  autoApprove?: boolean;
  shell?: boolean;
  server?: string;
  autoStart?: boolean;
  token?: string;
  nonInteractive?: boolean;
}

async function runInteractive(opts: CliOpts): Promise<void> {
  // Check that we're running in a real terminal (TTY)
  if (!process.stdin.isTTY) {
    console.error(
      "Error: Interactive TUI mode requires a real terminal (TTY).\n" +
      "  - On Windows, use Windows Terminal, cmd.exe, or PowerShell.\n" +
      "  - Git Bash with winpty may not work — use mintty or Windows Terminal.\n" +
      "  - For non-TTY environments, use --non-interactive (-n) mode instead:\n" +
      "    oc -n -p \"your prompt\"\n"
    );
    process.exit(1);
  }

  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { App } = await import("./app.js");
  const { ServerManager } = await import("./client/server-manager.js");

  const serverUrl = opts.server ?? "http://127.0.0.1:9876";

  // The server is NOT started here synchronously — instead we hand the
  // ServerManager to <App>, which renders ConnectingScreen first and kicks
  // off sm.start() inside a useEffect. This makes the "connecting…" phase
  // genuinely visible to the user rather than flashing by in one frame.
  // --no-auto-server skips the spawn and only probes for an existing server.
  const sm = new ServerManager({
    serverUrl,
    autoStart: opts.autoStart !== false,
  });

  const appProps = {
    modelSpec: opts.model,
    initialPrompt: opts.prompt,
    agentName: opts.agent ?? "agent",
    autoApprove: opts.autoApprove === true,
    enableShell: opts.shell !== false,
    serverUrl,
    token: opts.token,
    // App owns the connection lifecycle; no pre-resolved error here.
    initialError: undefined,
    serverManager: sm,
  };

  // Clear the terminal before rendering: erase the visible screen (\x1b[2J),
  // the scrollback buffer (\x1b[3J), and home the cursor (\x1b[H). This wipes
  // the shell history/previous command output so the TUI starts on a clean
  // canvas. Done before render() to avoid any flicker from Ink painting over
  // stale content.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  try {
    // Render options:
    //
    // alternateScreen is OFF — we use the normal screen buffer so that Ink's
    // <Static> component can write completed messages into the terminal's scroll
    // backlog (alternate screen has no scrollback, so static output would be
    // lost). The user scrolls history with the terminal's native scrollback
    // (mouse wheel, Shift+PgUp, scrollbar).
    //
    // incrementalRendering: true — per-line diff updates reduce flicker during
    // streaming (Ink's Branch B rendering).
    //
    // patchConsole: false — keeps console.* output from interleaving with the
    // render region.
    const { waitUntilExit } = render(createElement(App, appProps), {
      patchConsole: false,
      incrementalRendering: true,
    });
    await waitUntilExit();
  } finally {
    // Tear down the server we spawned. If we reused an externally-launched
    // server, ServerManager.stop() is a no-op (it tracks what it started).
    await sm.stop();
  }
}

async function runNonInteractive(opts: CliOpts): Promise<void> {
  const { TuiClient } = await import("./client/client.js");

  if (!opts.prompt) {
    console.error("Error: --non-interactive requires --prompt");
    process.exit(2);
  }

  const client = new TuiClient({ baseUrl: opts.server ?? "http://127.0.0.1:9876", token: opts.token });

  try {
    const health = await client.checkHealth();
    if (!health.ok) {
      console.error(`Error: Server not ready — ${health.error ?? "unreachable"}`);
      process.exit(1);
    }

    // Open the launch directory as the agent's workspace so the agent operates
    // in the same cwd the user invoked `oc` from (mirrors interactive mode).
    let workspaceId: string | undefined;
    try {
      const ws = await client.client.openWorkspace(process.cwd());
      workspaceId = ws.id;
    } catch {
      // Best-effort — server will fall back to its default workspace.
    }

    console.error(`Sending: ${opts.prompt}`);

    const stream = await client.streamChat({
      messages: [{ role: "user", content: opts.prompt }],
      workspace_id: workspaceId,
    });

    let buffer = "";
    for await (const event of stream) {
      switch (event.status) {
        case "loading":
        case "reasoning": {
          const token = typeof event.response === "string"
            ? event.response
            : (event.response as Record<string, unknown>)?.content as string ?? "";
          process.stdout.write(token);
          break;
        }
        case "finished":
          process.stdout.write("\n");
          break;
        case "error":
          console.error(`\nError: ${event.error_message ?? event.message ?? "Unknown error"}`);
          process.exit(1);
        case "interrupted":
          console.error(`\n[HITL] ${event.message ?? "Agent paused"}`);
          process.exit(124);
      }
    }
  } catch (err) {
    logger.exception("Non-interactive mode failed", err);
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// =============================================================================
// Bootstrap
// =============================================================================

// Load .env (cwd/.env then ~/.deepagents/.env) before anything else, so env
// vars like OCTOPUS_TUI_DEBUG are available for logging init.
loadDotEnv();

// Initialize logging before parsing — env var works immediately. The --debug
// flag is re-checked in the preAction hook below (after Commander parses args).
initTuiLogging(0, process.env["OCTOPUS_TUI_DEBUG"]);

program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.debug) {
    // Re-init with the CLI flag enabled (in case env var wasn't set).
    // Commander doesn't count flag repetitions, so --debug --debug is the
    // same as --debug here; use OCTOPUS_TUI_DEBUG=2 for verbose/trace.
    initTuiLogging(1, process.env["OCTOPUS_TUI_DEBUG"]);
  }
});

program.parse();
