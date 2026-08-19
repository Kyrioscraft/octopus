# Octopus / 八爪鱼 README 重写计划

## 目标
为开源发布重写 `README.md`，采用中英双语格式，覆盖开源项目的标准内容。

## README 结构

### 1. 头部区域
- 项目标题：**Octopus** / **八爪鱼**
- 一句话简介（双语）：AI Agent 多智能体协作平台
- 徽章占位：License (MIT)、Node >= 22、pnpm >= 10（后续可补充 GitHub stars、CI 等）

### 2. English Section

#### Features
- Multi-model support（Anthropic、OpenAI、DeepSeek、OpenRouter 等 20+ 提供商）
- MCP (Model Context Protocol) integration（stdio/SSE/HTTP 传输）
- Skills system（7 源分层发现、内置技能、Claude 兼容）
- Sub-agents system（自定义子智能体、模型覆盖）
- HITL (Human-in-the-Loop) interactive approval
- Multiple interfaces: Web UI (React 19 + Ant Design)、TUI (Ink/React)、CLI
- Streaming NDJSON protocol（实时 token 流）
- Workspace file management（文件树、读写、上传下载）
- Sandbox execution support (LangSmith)
- Built-in tools: web search (Tavily)、URL fetch (SSRF protection)
- JWT + Argon2 authentication
- Skills / MCP / Subagents configuration via Web UI or API

#### Architecture
```
web (React 19 + Ant Design + Zustand)
  └── tentacle (client SDK)
        └── server (Hono HTTP server, NDJSON streaming)
              └── core (LangGraph agent engine, MCP, skills, subagents)
tui (Ink + React + Commander) ──→ tentacle ──→ server ──→ core
```

#### Quick Start
1. 前置要求：Node.js >= 22、pnpm >= 10
2. `git clone` + `pnpm install`
3. 配置 `server/.env`（至少一个 API key）
4. `pnpm build` 构建所有包
5. `pnpm dev:server` + `pnpm dev:web` 启动服务
6. 访问 `http://localhost:5173`

#### Project Structure
五包的 monorepo 目录树（简化版，不超过 40 行）

#### Configuration
关键环境变量表格（来自 `.env.example`）

#### Contributing
简要说明贡献方式（Issue / PR）和开发约定（来自 `AGENTS.md`）

#### License
MIT License

### 3. 中文部分（结构对称）

#### 特性
与英文 Features 对应的中文版本

#### 架构
中文架构图说明

#### 快速开始
中文版安装运行步骤

#### 项目结构
中文版目录说明

#### 配置
中文版环境变量表格

#### 贡献
中文版贡献指南

#### 许可证
MIT 许可证说明

## 文件变更
- 仅修改 `README.md`（完全重写）
- 不动其他任何文件

## 编写原则
- 内容准确：基于 `AGENTS.md`、`package.json`、`server/.env.example` 和源码中的实际功能
- 格式规范：标准 Markdown，代码块标注语言，表格对齐
- 中文名统一使用「八爪鱼」
- 徽章使用 shields.io 占位 URL（后续填入实际仓库地址即可生效）
- 不包含截图
- 双语内容一致但非逐字翻译，各自符合语言习惯
- 目录树不超过 50 行，突出关键文件
- 英文优先在前，中文在后