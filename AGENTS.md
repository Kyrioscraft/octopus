# AGENTS.md

Guidance for ZCode agents working in this repository.

## Project overview

Octopus is an AI agent web application (monorepo) built with TypeScript,
LangChain v1 + LangGraph + the `deepagents` SDK on the backend, and React 19 +
Ant Design on the frontend. The codebase is a TypeScript port of an earlier
Python service (`cortex.*` modules) — many files reference the original Python
in comments ("Equivalent to Python ..."). Treat those references as the source
of truth for behavior when in doubt.

## Repository layout

It is a **pnpm/npm workspaces monorepo** (package names scoped under
`@octopus/*`). Four packages, each with its own `package.json` and `tsconfig.json`:

- `core/` — `@octopus/core`. Agent engine: builds LangGraph graphs from
  `ServerConfig`, reads `~/.deepagents/config.toml`, resolves model providers,
  exposes logging, config, and built-in tools. Pure library — no HTTP.
- `server/` — `@octopus/server`. Hono HTTP server (port 9876) serving
  `/api/auth/*` and `/api/chat/*`. Streams agent output as **NDJSON**. Depends
  on `@octopus/core`.
- `web/` — `@octopus/web`. React 19 + Ant Design + Zustand SPA (Vite, port
  5173). Proxies `/api` → `http://127.0.0.1:9876`. Depends on `@octopus/tentacle`.
- `tentacle/` — `@octopus/tentacle`. Typed browser/Node client for the server
  API (`OctopusClient`) plus NDJSON stream parsing. Shared by `web`.

> Note: `core/tsconfig.json` and `server/tsconfig.json` extend
> `../../tsconfig.base.json`, which does **not** currently exist in the repo.
> Add it at the root before running `tsc` in those packages, or the build will
> fail.

## Commands (per package)

There is no root-level `package.json`. Run each command inside its package
directory (e.g. `cd server && npm run build`):

| Command | core | server | tentacle | web |
|---------|------|--------|----------|-----|
| `build` | `tsc` | `tsc` | `tsc` | `tsc -b && vite build` |
| `dev` | `tsc --watch` | `concurrently -n tsc,node "tsc --watch --preserveWatchOutput" "node --watch dist/main.js"` | `tsc --watch` | `vite` |
| `lint` / typecheck | `tsc --noEmit` | `tsc --noEmit` | `tsc --noEmit` | `tsc --noEmit` |
| `start` | — | `node dist/main.js` | — | — |

There is **no test runner** configured in any package. Do not invent test
commands — verify changes with `lint` (which is `tsc --noEmit`).

Package linking is via `workspace:*`; build `core` and `tentacle` before
running `server`/`web`, since they import compiled `dist/` output.

## Architecture boundaries & conventions

- **No circular deps between packages.** Dependency direction is:
  `web → tentacle`, `server → core`. `web` must **not** import `server` or
  `core` directly — it talks to the server exclusively through `tentacle`'s
  `OctopusClient`.
- **`core` is environment-agnostic** — no HTTP, no DB. Keep it free of Node
  server concerns. HTTP/routing/auth/persistence live in `server`.
- **ESM only.** Every package sets `"type": "module"`. Use `node:` protocol
  for Node built-ins (`node:fs`, `node:os`, `node:async_hooks`).
- **Imports between files use the `.js` extension** even though sources are
  `.ts` (e.g. `import { getLogger } from "./logging.js";`). This is required
  by the ESM + `tsc` setup — do not drop the `.js`.
- **Cross-package imports use the package name**, not relative paths:
  `import { loadConfig } from "@octopus/core";`.

### LangGraph / deepagents specifics (core + server)

- Agent graphs are compiled in `core/src/agent.ts` via `createDeepAgent`, then
  cached by a signature key (model + prompt + tools + flags). **Always call
  `clearGraphCache()` after changing config that affects graph shape**,
  otherwise stale graphs are reused.
- HITL (human-in-the-loop) interrupts are the normal control-flow mechanism —
  `GraphInterrupt` is **not an error**. The chat router in
  `server/src/routes/chat.ts` catches it and resumes with a
  `Command({ resume: { decisions: [...] } })`. The `decisions` array length
  **must** match the number of interrupted action requests.
- **Agents (not "modes")** — the old AccessMode (plan/confirm/auto/full) is
  now data-driven agent presets in `core/src/agents/builtin.ts`
  (`AgentPreset`: promptBlock / disabledTools / interruptOnOverride /
  bypassFileEditGuard / submitPlan / permissionConfig). `makeGraph` takes
  `agent?: string` (`accessMode` is a deprecated alias — same values).
  Wire field `agent` (legacy `mode` still accepted). Plan mode has a
  `submit_plan` approval gate (opencode plan_exit equivalent); approval
  switches the thread to the confirm agent + injects a synthetic user
  message. Agent is bound per message (`messages.extra_metadata.agent`),
  inherited from the last user message when unspecified.
- **Permission rules** — `core/src/permission/` implements opencode-style
  pattern rules (`allow`/`ask`/`deny` + globs, findLast evaluation, default
  `ask`). Preset `interruptOnOverride` is DERIVED from
  `permissionConfig` via `interruptOnForRuleset`. HITL "always" approvals
  persist as thread-level rules (`threads.permission` JSON column, cleared on
  agent switch) and are merged into the runtime `interruptOn` override.
  See `AGENT_MIGRATION_PLAN.md` for the full design + implementation log.
- Model spec format is `"provider:model"` (e.g. `"anthropic:claude-sonnet-4-6"`).
  Unknown providers fall back to OpenAI-compatible `ChatOpenAI` with a custom
  `baseURL`.
- `MemorySaver` checkpointer is a **process-level singleton** — state is lost
  on server restart.

### Server conventions

- **Streaming protocol = NDJSON** (newline-delimited JSON), content type
  `application/x-ndjson`. Each line is one chunk with a `status` field
  (`init`, `loading`, `reasoning`, `finished`, `error`,
  `ask_user_question_required`). `tentacle` parses this via
  `parseNDJSONStream`.
- **Persistence is currently a JSON file** (`data/octopus.json`, override with
  `OCTOPUS_DB_PATH`), *not* SQLite — comments note Drizzle/better-sqlite3 is
  planned for "Phase 2". A default `octopus / octopus` superadmin is
  auto-created on first run (dev convenience).
- **Auth** = JWT (jose) + argon2 hashing. Middleware sets `c.var.user`.
- **Logging** — use `getLogger("module.name")` from `@octopus/core`, never
  `console.*`. Format and `AsyncLocalStorage` request context live in
  `core/src/logging.ts`. `logger.exception(msg, err)` is the pattern for
  caught errors.
- User-facing error strings and many prompts are **Chinese** (e.g.
  `"会话不存在"`, `"未知错误"`). Match the surrounding language when editing
  these.

## Configuration & environment

Config resolution precedence (highest first), in `core/src/config.ts`:
1. `OCTOPUS_MODEL` env var
2. `OCTOPUS_DEFAULT_MODEL` (from `.env`)
3. `~/.deepagents/config.toml` `[models].default`
4. Hardcoded `"anthropic:claude-sonnet-4-6"`

Key env vars (see `core/src/constants.ts` for the full provider registry):
- `OCTOPUS_WEB_PORT` (default 9876), `OCTOPUS_LOG_LEVEL` (default INFO)
- `OCTOPUS_INTERACTIVE`, `OCTOPUS_AUTO_APPROVE`, `OCTOPUS_ENABLE_SHELL`,
  `OCTOPUS_ENABLE_WEB_SEARCH`
- Provider API keys follow the registry (e.g. `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`). The `DEEPAGENTS_CODE_` prefix is supported as an
  env-override namespace.
- `server/.env` is gitignored and loaded via `loadDotEnv()` at startup.
  **Never commit API keys.** (The current untracked `server/.env` contains a
  plaintext `OPENAI_API_KEY` — rotate it if it was ever shared.)

## Gotchas

- `tsconfig.base.json` is referenced but missing from the repo root — create
  it (or fix the `extends`) before `core`/`server` will compile.
- `createAgent()` in `core` is a deprecated alias for `makeGraph()`; prefer
  `makeGraph()` for new code.
- The DB layer is in-memory + JSON file; it is **not** safe for concurrent
  multi-process writes. Don't assume transactional safety.
- Vite dev server proxies `/api` to port 9876 — both `server` and `web` must
  run for local development.
