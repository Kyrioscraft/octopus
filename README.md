# Octopus / 八爪鱼

> AI Agent multi-agent collaboration platform

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-blue)](https://pnpm.io)

中文文档请参阅 [README_zh.md](./README_zh.md).

---

Octopus is an AI agent platform that lets you chat with LLMs, give them tools, and orchestrate multi-agent workflows. It supports multiple model providers, MCP (Model Context Protocol) tools, custom skills, and sub-agents — all manageable through a Web UI, terminal TUI, or CLI.

## Highlights

- **Multi-model** — Anthropic, OpenAI, DeepSeek, OpenRouter, and any OpenAI-compatible provider. Switch models per request.
- **MCP native** — Connect to MCP servers over stdio / SSE / HTTP. Tools are auto-discovered and namespaced.
- **Skills & sub-agents** — Extend the agent with markdown-defined skills and sub-agents. Hierarchical file-based discovery with override semantics.
- **HITL approval** — Human-in-the-loop with plan / confirm / auto execution agents. Review tool calls before they run.
- **Multi-interface** — Web UI (React), terminal TUI (Ink), and headless CLI. Same backend, your choice.

## Architecture

```
web / tui  ──→  tentacle (client SDK)  ──→  server (Hono + NDJSON streaming)  ──→  core (LangGraph / deepagents engine)
```

Five packages in a pnpm monorepo, all under [`packages/`](./packages):

| Package | Purpose |
|---------|---------|
| [`core`](./packages/core) | Agent engine: LangGraph graphs, model providers, tools, permissions, config, logging |
| [`server`](./packages/server) | Hono HTTP server (port 9876): auth + chat API, NDJSON streaming, persistence |
| [`tentacle`](./packages/tentacle) | Typed browser/Node client SDK + NDJSON stream parsing |
| [`web`](./packages/web) | React 19 + Ant Design + Zustand SPA (Vite, port 5173) |
| [`tui`](./packages/tui) | Terminal UI (Ink) and headless `oc` CLI |

See [`AGENTS.md`](./AGENTS.md) for development conventions and [`architecture/`](./architecture) for design documents.

## Quick Start

```bash
# Prerequisites: Node.js >= 22, pnpm >= 10
git clone https://github.com/username/octopus.git
cd octopus
pnpm install

# Configure at least one API key
cp packages/server/.env.example packages/server/.env
# Edit packages/server/.env: OPENAI_API_KEY=sk-...

pnpm build

# Terminal 1: server
pnpm dev:server

# Terminal 2: web UI
pnpm dev:web
# → http://localhost:5173  (default account: octopus / octopus)
```

Also try the terminal UI: `pnpm oc`

Want it available everywhere? Register the short `oc` command once:

```bash
pnpm --filter @octopus/tui link --global
oc              # launch the TUI from any directory
oc -n -p "hi"   # one-shot / non-interactive
oc agents       # headless subcommands
```

## Configuration

Set these in `packages/server/.env` (see `packages/server/.env.example` for all options):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | LLM API key (Anthropic, DeepSeek, OpenRouter also supported) |
| `OCTOPUS_WEB_PORT` | `9876` | Server port |
| `OCTOPUS_MODEL` | — | Override default model (`provider:model`) |
| `OCTOPUS_ENABLE_SHELL` | `false` | Allow agent shell execution |
| `OCTOPUS_ENABLE_WEB_SEARCH` | `true` | Enable web search tool |
| `OCTOPUS_DB_PATH` | `data/octopus.db` | Database path (relative to the server working directory) |

## License

[MIT](./LICENSE) © 2026 Wyatt
