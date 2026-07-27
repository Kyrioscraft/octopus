/**
 * Middleware for injecting local context into the system prompt.
 *
 * Detects git state, project structure, package managers, runtimes, and
 * directory layout by running a bash script via the backend. Because the
 * script executes inside the backend (local shell or remote sandbox), the
 * same detection logic works regardless of where the agent runs.
 *
 * Equivalent to Python `cortex.local_context`.
 */

import { getLogger } from "../logging.js";
import { sanitizeControlChars } from "../unicode_security.js";
import type { MCPServerInfo } from "../mcp_tools.js";

const logger = getLogger("local.context");

// =============================================================================
// Constants — matching Python.
// =============================================================================

const TOOL_NAME_DISPLAY_LIMIT = 10;
const DETECT_SCRIPT_TIMEOUT = 30;
const MCP_ERROR_DETAIL_LIMIT = 200;

// =============================================================================
// MCP context formatting — equivalent to Python `_build_mcp_context()`.
// =============================================================================

function _sanitizeErrorDetail(error?: string | null): string {
  if (!error) return "unknown error";
  return sanitizeControlChars(error).slice(0, MCP_ERROR_DETAIL_LIMIT) || "unknown error";
}

/**
 * Format MCP server/tool inventory for the system prompt.
 *
 * Equivalent to Python `_build_mcp_context()`.
 */
function _buildMcpContext(servers: MCPServerInfo[]): string {
  if (!servers || servers.length === 0) return "";

  const totalTools = servers.reduce((sum: number, s) => sum + s.tools.length, 0);
  const lines: string[] = [
    `**MCP Servers** (${servers.length} servers, ${totalTools} tools):`,
  ];

  for (const server of servers) {
    if (!server.tools || server.tools.length === 0) {
      if (server.status === "error") {
        const detail = _sanitizeErrorDetail(server.error);
        lines.push(
          `- **${server.name}** (${server.transport}): ` +
          `FAILED TO LOAD — <error>${detail}</error>. ` +
          "Treat this integration as temporarily unavailable; " +
          "tell the user the server failed to load and suggest " +
          "restarting the MCP server.",
        );
      } else if (server.status === "unauthenticated") {
        const detail = _sanitizeErrorDetail(server.error);
        lines.push(
          `- **${server.name}** (${server.transport}): ` +
          `NEEDS LOGIN — <error>${detail}</error>. ` +
          "This integration requires authentication before its " +
          "tools are available; tell the user and suggest running " +
          "`/mcp` to log in.",
        );
      } else if (server.status === "disabled") {
        lines.push(
          `- **${server.name}** (${server.transport}): (disabled by user)`,
        );
      } else {
        lines.push(
          `- **${server.name}** (${server.transport}): (no tools registered)`,
        );
      }
      continue;
    }

    const names = server.tools.map((t) => t.name);
    if (names.length > TOOL_NAME_DISPLAY_LIMIT) {
      const shown = names.slice(0, TOOL_NAME_DISPLAY_LIMIT).join(", ");
      const remaining = names.length - TOOL_NAME_DISPLAY_LIMIT;
      lines.push(
        `- **${server.name}** (${server.transport}): ` +
        `${shown}, and ${remaining} more`,
      );
    } else {
      lines.push(
        `- **${server.name}** (${server.transport}): ${names.join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Bash detection script — equivalent to Python section functions.
//
// Outputs markdown describing the current working environment.
// Each section is guarded so missing tools are silently skipped.
// Independent sections run as parallel background subshells.
// =============================================================================

function _sectionHeader(): string {
  return `CWD="$(pwd)"
echo "## Local Context"
echo ""
echo "**Current Directory**: \\\`\${CWD}\\\`"
echo ""

# --- Check git once ---
IN_GIT=false
if command -v git >/dev/null 2>&1 \\
    && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IN_GIT=true
fi`;
}

function _sectionProject(): string {
  return `# --- Project ---
PROJ_LANG=""
[ -f pyproject.toml ] || [ -f setup.py ] && PROJ_LANG="python"
[ -z "$PROJ_LANG" ] && [ -f package.json ] && PROJ_LANG="javascript/typescript"
[ -z "$PROJ_LANG" ] && [ -f Cargo.toml ] && PROJ_LANG="rust"
[ -z "$PROJ_LANG" ] && [ -f go.mod ] && PROJ_LANG="go"
[ -z "$PROJ_LANG" ] && { [ -f pom.xml ] || [ -f build.gradle ]; } && PROJ_LANG="java"

MONOREPO=false
{ [ -f lerna.json ] || [ -f pnpm-workspace.yaml ] \\
  || [ -d packages ] || { [ -d libs ] && [ -d apps ]; } \\
  || [ -d workspaces ]; } && MONOREPO=true

ROOT=""
$IN_GIT && ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"

ENVS=""
{ [ -d .venv ] || [ -d venv ]; } && ENVS=".venv"
[ -d node_modules ] && ENVS="\${ENVS:+\${ENVS}, }node_modules"

HAS_PROJECT=false
{ [ -n "$PROJ_LANG" ] || { [ -n "$ROOT" ] && [ "$ROOT" != "$CWD" ]; } \\
  || $MONOREPO || [ -n "$ENVS" ]; } && HAS_PROJECT=true

if $HAS_PROJECT; then
  echo "**Project**:"
  [ -n "$PROJ_LANG" ] && echo "- Language: \${PROJ_LANG}"
  [ -n "$ROOT" ] && [ "$ROOT" != "$CWD" ] && echo "- Project root: \\\`\${ROOT}\\\`"
  $MONOREPO && echo "- Monorepo: yes"
  [ -n "$ENVS" ] && echo "- Environments: \${ENVS}"
  echo ""
fi`;
}

function _sectionPackageManagers(): string {
  return `# --- Package managers ---
PKG=""
if [ -f uv.lock ]; then PKG="Python: uv"
elif [ -f poetry.lock ]; then PKG="Python: poetry"
elif [ -f Pipfile.lock ] || [ -f Pipfile ]; then PKG="Python: pipenv"
elif [ -f pyproject.toml ]; then
  if grep -q '\\[tool\\.uv\\]' pyproject.toml 2>/dev/null; then PKG="Python: uv"
  elif grep -q '\\[tool\\.poetry\\]' pyproject.toml 2>/dev/null; then PKG="Python: poetry"
  else PKG="Python: pip"
  fi
elif [ -f requirements.txt ]; then PKG="Python: pip"
fi

NODE_PKG=""
if [ -f bun.lockb ] || [ -f bun.lock ]; then NODE_PKG="Node: bun"
elif [ -f pnpm-lock.yaml ]; then NODE_PKG="Node: pnpm"
elif [ -f yarn.lock ]; then NODE_PKG="Node: yarn"
elif [ -f package-lock.json ] || [ -f package.json ]; then NODE_PKG="Node: npm"
fi
[ -n "$NODE_PKG" ] && PKG="\${PKG:+\${PKG}, }\${NODE_PKG}"
[ -n "$PKG" ] && echo "**Package Manager**: \${PKG}" && echo ""`;
}

function _sectionRuntimes(): string {
  return `# --- Runtimes ---
RT=""
if command -v python3 >/dev/null 2>&1; then
  PV="$(python3 --version 2>/dev/null | awk '{print $2}')"
  [ -n "$PV" ] && RT="Python \${PV}"
fi
if command -v node >/dev/null 2>&1; then
  NV="$(node --version 2>/dev/null | sed 's/^v//')"
  [ -n "$NV" ] && RT="\${RT:+\${RT}, }Node \${NV}"
fi
[ -n "$RT" ] && echo "**Detected Runtimes**: \${RT}" && echo ""`;
}

function _sectionGit(): string {
  return `# --- Git ---
if $IN_GIT; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$BRANCH" = "HEAD" ]; then
    COMMIT="$(git rev-parse --short HEAD 2>/dev/null)"
    GT="**Git**: Detached HEAD at \\\`\${COMMIT}\\\`"
  else
    GT="**Git**: Current branch \\\`\${BRANCH}\\\`"
  fi

  MAINS=""
  for b in $(git branch 2>/dev/null | sed 's/^[* ]*//'); do
    case "$b" in
      main) MAINS="\${MAINS:+\${MAINS}, }\\\`main\\\`" ;;
      master) MAINS="\${MAINS:+\${MAINS}, }\\\`master\\\`" ;;
    esac
  done
  [ -n "$MAINS" ] && GT="\${GT}, \${MAINS} available"

  DC=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$DC" -gt 0 ]; then
    if [ "$DC" -eq 1 ]; then GT="\${GT}, 1 uncommitted change"
    else GT="\${GT}, \${DC} uncommitted changes"
    fi
  fi

  echo "$GT"
  echo ""
fi`;
}

function _sectionGhCli(): string {
  return `# --- GitHub CLI ---
if command -v gh >/dev/null 2>&1; then
  _gh_json_fields() {
    gh search "$1" --help 2>/dev/null \\
      | awk '
        /^JSON FIELDS/ { in_fields = 1; next }
        in_fields && /^$/ { exit }
        in_fields { gsub(/^  /, ""); print }
      ' \\
      | tr '\\n' ' ' \\
      | sed 's/  */ /g; s/^ //; s/ $//'
  }

  GH_PRS_FIELDS="$(_gh_json_fields prs)"
  GH_ISSUES_FIELDS="$(_gh_json_fields issues)"
  if [ -n "$GH_PRS_FIELDS" ] || [ -n "$GH_ISSUES_FIELDS" ]; then
    echo "**GitHub CLI**:"
    [ -n "$GH_PRS_FIELDS" ] \\
      && echo "- \\\`gh search prs --json\\\` fields: \${GH_PRS_FIELDS}"
    [ -n "$GH_ISSUES_FIELDS" ] \\
      && echo "- \\\`gh search issues --json\\\` fields: \${GH_ISSUES_FIELDS}"
    case ",$GH_PRS_FIELDS," in
      *mergedAt*) ;;
      *) echo "- \\\`gh search prs --json\\\` does not expose \\\`mergedAt\\\`;"
         echo "  use \\\`gh pr view --json mergedAt\\\` per PR for merge timestamps." ;;
    esac
    echo ""
  fi
fi`;
}

function _sectionTestCommand(): string {
  return `# --- Test command ---
TC=""
if [ -f Makefile ] && grep -qE '^tests?:' Makefile 2>/dev/null; then TC="make test"
elif [ -f pyproject.toml ]; then
  if grep -q '\\[tool\\.pytest' pyproject.toml 2>/dev/null \\
      || [ -f pytest.ini ] || [ -d tests ] || [ -d test ]; then
    TC="pytest"
  fi
elif [ -f package.json ] \\
    && grep -q '"test"' package.json 2>/dev/null; then
  TC="npm test"
fi
[ -n "$TC" ] && echo "**Run Tests**: \\\`\${TC}\\\`" && echo ""`;
}

function _sectionFiles(): string {
  return `# --- Files ---
EXCL='node_modules|__pycache__|\\.pytest_cache'
EXCL="\${EXCL}|\\.mypy_cache|\\.ruff_cache|\\.tox"
EXCL="\${EXCL}|\\.coverage|\\.eggs|dist|build"
FILES=$(
  { ls -1 2>/dev/null; [ -e .deepagents ] && echo .deepagents; } |
  grep -vE "^($EXCL)$" |
  sort -u
)
if [ -n "$FILES" ]; then
  TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')
  SHOWN_FILES=$(echo "$FILES" | head -20)
  SHOWN=$(echo "$SHOWN_FILES" | wc -l | tr -d ' ')
  TOTAL=\${TOTAL:-0}
  SHOWN=\${SHOWN:-0}
  if [ "$SHOWN" -lt "$TOTAL" ]; then
    echo "**Files** (showing \${SHOWN} of \${TOTAL}):"
  else
    echo "**Files** (\${TOTAL}):"
  fi
  echo "$SHOWN_FILES" | while IFS= read -r f; do
    if [ -d "$f" ]; then echo "- \${f}/"
    else echo "- \${f}"
    fi
  done
  echo ""
fi`;
}

function _sectionTree(): string {
  return `# --- Tree ---
if command -v tree >/dev/null 2>&1; then
  TREE_EXCL='node_modules|.venv|__pycache__|.pytest_cache'
  TREE_EXCL="\${TREE_EXCL}|.git|.mypy_cache|.ruff_cache"
  TREE_EXCL="\${TREE_EXCL}|.tox|.coverage|.eggs|dist|build"
  T_PREVIEW=$(tree -L 3 --noreport --dirsfirst \\
    -I "$TREE_EXCL" 2>/dev/null | sed -n '1,22p;23{p;q;}')
  if [ -n "$T_PREVIEW" ]; then
    PREVIEW_LINES=$(echo "$T_PREVIEW" | wc -l | tr -d ' ')
    PREVIEW_LINES=\${PREVIEW_LINES:-0}
    T="$T_PREVIEW"
    TREE_TRUNCATED=false
    if [ "$PREVIEW_LINES" -gt 22 ]; then
      T=$(echo "$T_PREVIEW" | head -22)
      TREE_TRUNCATED=true
    fi
    echo "**Tree** (3 levels):"
    echo '\`\`\`text'
    echo "$T"
    $TREE_TRUNCATED && echo "... (more lines truncated)"
    echo '\`\`\`'
    echo ""
  fi
fi`;
}

function _sectionMakefile(): string {
  return `# --- Makefile ---
MK=""
if [ -f Makefile ]; then
  MK="Makefile"
elif [ -n "$ROOT" ] && [ "$ROOT" != "$CWD" ] && [ -f "\${ROOT}/Makefile" ]; then
  MK="\${ROOT}/Makefile"
fi
if [ -n "$MK" ]; then
  echo "**Makefile** (\\\`\${MK}\\\`, first 20 lines):"
  echo '\`\`\`makefile'
  head -20 "$MK"
  TL=$(wc -l < "$MK" | tr -d ' ')
  [ "$TL" -gt 20 ] && echo "... (truncated)"
  echo '\`\`\`'
fi`;
}

/**
 * Build the complete detection script by concatenating all sections.
 *
 * Independent sections run as parallel background jobs writing to temp
 * files, then results are concatenated in the original display order.
 * The header (CWD / IN_GIT) and project section (sets ROOT) run first
 * because later sections depend on their variables.
 *
 * Equivalent to Python `build_detect_script()`.
 */
function buildDetectScript(): string {
  // Header + project run synchronously (set CWD, IN_GIT, ROOT for others)
  const serialPrefix = `${_sectionHeader()}\n${_sectionProject()}`;

  // These sections are independent — run them in parallel.
  const parallelSections: [string, string][] = [
    ["02_pkgmgr", _sectionPackageManagers()],
    ["03_runtimes", _sectionRuntimes()],
    ["04_git", _sectionGit()],
    ["05_gh_cli", _sectionGhCli()],
    ["06_testcmd", _sectionTestCommand()],
    ["07_files", _sectionFiles()],
    ["08_tree", _sectionTree()],
    ["09_makefile", _sectionMakefile()],
  ];

  const parallelSetup = "_DCT=$(mktemp -d) || exit 1\ntrap 'rm -rf \"$_DCT\"' EXIT";
  const parallelBlock = parallelSections
    .map(([name, body]) => `(\n${body}\n) > "$_DCT/${name}" 2>"$_DCT/${name}.err" &`)
    .join("\n");
  const catLine = "cat " + parallelSections.map(([name]) => `"$_DCT/${name}"`).join(" ");

  const body = `${serialPrefix}\n${parallelSetup}\n${parallelBlock}\nwait\n${catLine}`;
  return `bash <<'__DETECT_CONTEXT_EOF__'\n${body}\n__DETECT_CONTEXT_EOF__\n`;
}

/** Pre-built detection script (cached). */
const DETECT_CONTEXT_SCRIPT = buildDetectScript();

// =============================================================================
// LocalContextMiddleware — equivalent to Python `LocalContextMiddleware`.
// =============================================================================

/**
 * Backend interface that supports sync `execute()`.
 * Matches `LocalShellBackend` and compatible backends.
 */
interface ExecutableBackend {
  execute(command: string, options?: { timeout?: number }): {
    output?: string;
    exitCode?: number | null;
  };
}

/**
 * Middleware that injects local context (git state, project structure, etc.)
 * into the system prompt.
 *
 * Runs a bash detection script via `backend.execute()` on first interaction
 * and again after each summarization event, stores the result in state, and
 * appends it to the system prompt on every model call.
 *
 * Equivalent to Python `LocalContextMiddleware`.
 */
class LocalContextMiddleware {
  name = "LocalContextMiddleware";

  private backend: ExecutableBackend;
  private _mcpContext: string;

  stateSchema = {
    localContext: { default: () => undefined as string | undefined },
    _localContextRefreshedAtCutoff: { default: () => undefined as number | undefined },
  };

  constructor(
    backend: ExecutableBackend,
    mcpServerInfo?: MCPServerInfo[] | null,
  ) {
    this.backend = backend;
    this._mcpContext = _buildMcpContext(mcpServerInfo ?? []);
  }

  private _handleDetectResult = (result: {
    output?: string;
    exitCode?: number | null;
  }): string | undefined => {
    const output = (result.output ?? "").trim();
    if (result.exitCode === undefined || result.exitCode === null || result.exitCode !== 0) {
      logger.warn(
        `Local context detection script ${
          result.exitCode != null
            ? `exited with code ${result.exitCode}`
            : "did not report an exit code"
        }; context will be omitted. Output: ${output?.slice(0, 200) || "(empty)"}`,
      );
      return undefined;
    }
    if (!output) {
      logger.debug("Local context detection script succeeded but produced no output");
    }
    return output || undefined;
  };

  private _runDetectScript = (): string | undefined => {
    try {
      const result = this.backend.execute(DETECT_CONTEXT_SCRIPT, {
        timeout: DETECT_SCRIPT_TIMEOUT,
      });
      return this._handleDetectResult(result);
    } catch (err) {
      logger.warn(
        `Local context detection failed; context will be omitted from system prompt: ${String(err)}`,
      );
      return undefined;
    }
  };

  beforeAgent = (
    state: Record<string, unknown>,
    _runtime: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    // --- Post-summarization refresh ---
    const rawEvent = state["_summarization_event"];
    if (rawEvent != null && typeof rawEvent === "object") {
      const event = rawEvent as Record<string, unknown>;
      const cutoff = event["cutoff_index"];
      const refreshedCutoff = state["_localContextRefreshedAtCutoff"];
      if (cutoff !== refreshedCutoff) {
        const output = this._runDetectScript();
        if (output) {
          return {
            localContext: output,
            _localContextRefreshedAtCutoff: cutoff,
          };
        }
        return { _localContextRefreshedAtCutoff: cutoff };
      }
    }

    // --- Initial detection (first invocation) ---
    if (state["localContext"]) return undefined;

    const output = this._runDetectScript();
    if (output) {
      return { localContext: output };
    }
    return undefined;
  };

  private _getModifiedRequest = (request: {
    systemPrompt?: string;
    state?: Record<string, unknown>;
    override?: (overrides: Record<string, unknown>) => any;
  }): any | undefined => {
    const state = (request.state ?? {}) as Record<string, unknown>;
    const localContext = (state["localContext"] as string) || "";

    const parts = [localContext, this._mcpContext].filter(Boolean);
    if (parts.length === 0) return undefined;

    const systemPrompt = request.systemPrompt || "";
    const newPrompt = systemPrompt + "\n\n" + parts.join("\n\n");

    if (typeof request.override === "function") {
      return request.override({ systemPrompt: newPrompt });
    }
    return { ...request, systemPrompt: newPrompt };
  };

  wrapModelCall = (
    request: {
      systemPrompt?: string;
      state?: Record<string, unknown>;
      override?: (overrides: Record<string, unknown>) => any;
    },
    handler: (req: any) => any,
  ): any => {
    const modifiedRequest = this._getModifiedRequest(request);
    return handler(modifiedRequest || request);
  };
}

export { LocalContextMiddleware, buildDetectScript, _buildMcpContext as buildMcpContext };
