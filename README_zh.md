# Octopus / 八爪鱼

> AI Agent 多智能体协作平台

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-blue)](https://pnpm.io)

For English documentation, see [README.md](./README.md).

---

Octopus（八爪鱼）是一个 AI 智能体平台，支持多模型对话、工具调用、多智能体协作。通过 MCP（模型上下文协议）集成外部工具，支持自定义技能和子智能体，提供 Web UI、终端 TUI 和命令行三种交互方式。

## 亮点

- **多模型** — 支持 Anthropic、OpenAI、DeepSeek、OpenRouter 以及任意 OpenAI 兼容提供商，可按请求动态切换模型。
- **MCP 原生** — 通过 stdio / SSE / HTTP 连接 MCP 服务，工具自动发现并命名空间隔离。
- **技能与子智能体** — 以 Markdown 文件定义技能和子智能体，支持文件系统分层发现和优先级覆盖。
- **人机交互（HITL）** — 提供计划 / 确认 / 自动三种执行模式，可在工具执行前进行审批。
- **多端界面** — Web UI（React）、终端 TUI（Ink）、无头 CLI，共用同一后端。

## 架构

```
web / tui  ──→  tentacle（客户端 SDK）  ──→  server（Hono + NDJSON 流式）  ──→  core（LangGraph / deepagents 引擎）
```

五个包组成的 pnpm monorepo — `core`、`server`、`tentacle`、`web`、`tui`。开发约定详见 [`AGENTS.md`](./AGENTS.md)。

## 快速开始

```bash
# 环境要求：Node.js >= 22, pnpm >= 10
git clone https://github.com/username/octopus.git
cd octopus
pnpm install

# 配置至少一个 API Key
cp server/.env.example server/.env
# 编辑 server/.env: OPENAI_API_KEY=sk-...

pnpm build

# 终端 1：启动服务端
pnpm dev:server

# 终端 2：启动 Web 界面
pnpm dev:web
# → http://localhost:5173（默认账户：octopus / octopus）
```

也可以使用终端界面：`pnpm oc`

想要在任意目录使用？一次性注册简短的 `oc` 命令：

```bash
pnpm --filter @octopus/tui link --global
oc              # 在任意目录启动 TUI
oc -n -p "你好"  # 非交互模式（单次执行）
oc agents       # 无界面子命令
```

## 配置

在 `server/.env` 中设置：

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | LLM API 密钥（同样支持 Anthropic、DeepSeek、OpenRouter 等） |
| `OCTOPUS_WEB_PORT` | `9876` | 服务端口 |
| `OCTOPUS_MODEL` | — | 覆盖默认模型（格式：`provider:model`） |
| `OCTOPUS_ENABLE_SHELL` | `false` | 允许智能体执行 shell 命令 |
| `OCTOPUS_ENABLE_WEB_SEARCH` | `true` | 启用网络搜索工具 |
| `OCTOPUS_DB_PATH` | `data/octopus.db` | 数据库文件路径 |

完整选项见 `server/.env.example`。

## 许可证

[MIT](./LICENSE) © 2026 Wyatt
