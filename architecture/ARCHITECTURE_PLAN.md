# Octopus — core/server 抽象优化与多 UI 兼容架构

> **状态：已实施。** 本文仅保留仍然有效的架构决策与分层约定，
> 作为 `packages/` 各包演进的参考。历史迁移步骤与排查记录已删除。

---

## 1. 设计目标与原则

| 目标 | 衡量标准 |
|---|---|
| 服务接口精简、功能清晰 | 单一职责；每个 HTTP 端点可一句话描述；契约类型单点定义 |
| 多 UI 共用、兼容性好 | web 与 tui 共用同一套**基础接口**，行为一致；契约变更不破坏旧客户端 |
| 特化功能兼容 | UI 特有能力（附件、反馈、agent 配置）走**扩展路径分组**（`/api/chat/ext/*`），不污染基础接口 |
| core/server 分层干净 | core 暴露稳定的**引擎接口**，server 是其 HTTP 适配层，未来可换 agent 运行时 |

**核心原则：core 引擎接口化 + 基础接口/扩展路径分组。**

## 2. 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层  (packages/web / packages/tui)                        │
│  只依赖 @octopus/tentacle 的 OctopusClient + 类型契约          │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP (REST 基础 + NDJSON 流 + /ext/* 扩展)
┌────────────────────────▼────────────────────────────────────┐
│  server 层  (packages/server)                                │
│  routes/（HTTP 适配）→ services/（业务编排）→ core 引擎 + db  │
└────────────────────────┬────────────────────────────────────┘
                         │ TS 接口调用（引擎契约）
┌────────────────────────▼────────────────────────────────────┐
│  core 层  (packages/core)                                    │
│  AgentEngine + 标准化事件 + 各能力模块，零 HTTP 依赖            │
└─────────────────────────────────────────────────────────────┘
```

分层依赖方向严格不变：`web → tentacle`、`server → core`，禁止反向。
routes 只做参数校验、调用 service、流/JSON 编码；业务编排与协议序列化
集中在 services。

## 3. core 层：引擎接口 + 标准化事件

- **AgentEngine 门面**：`resolve(config, opts)`（编译/缓存 graph，
  接受 `extraSkills` / `extraMcpServers` 注入）、`stream(input)`、
  `generateTitle()`、`invalidate()`。`makeGraph()` 是内部实现细节，
  server 依赖接口而非具体实现 → 可替换 agent 运行时而不动 server。
- **AgentEvent 标准化事件**（与传输协议解耦）：`init / token /
  reasoning / tool_call / tool_result / subagent_started / interrupt /
  finished / error`。HITL 中断处理、partial 保存、subagent 渲染等
  逻辑下沉到 core，server 只负责序列化为 NDJSON。
- **graph 缓存**：缓存 key 需纳入注入的 `extraSkills` /
  `extraMcpServers` 签名，避免不同 user-defined 配置命中同一缓存；
  配置变更后必须 `invalidate()`。

## 4. API 设计：基础接口 + 扩展路径分组

### 4.1 基础接口（所有 UI 共用，精简稳定）

会话域（NDJSON 流式端点为 `POST /api/chat/agent` 与
`POST /api/chat/thread/:id/resume`）+ 配置资源域 `/api/config/*`
（skills / mcp 列表、详情、user-defined 增删改、MCP 启停）。

### 4.2 扩展路径分组 `/api/chat/ext/*`

**任何 UI 特有、非通用必备的能力**一律放 `/api/chat/ext/*`：

- `/ext/*` 前缀本身就是"可选、稳定性低于基础接口"的信号；
- 未实现的扩展端点返回标准 404，客户端按需 catch（隐藏对应 UI 元素），
  **不做统一降级链路**；
- 基础接口字段**绝不因扩展而变更**。

### 4.3 不引入能力探测机制（决策记录）

**刻意不采用**"服务端自描述能力清单 + 客户端探测 + 优雅降级"模式。
该模式适用于多方独立部署、无法同步发布的场景；octopus 是单仓库、
前后端同步发布，能力集合编译期已知，运行时探测是不存在的部署差异
付出的成本。当出现独立第三方部署或多 UI 差异大到无法同步发布时再
重新评估。

## 5. tentacle 层：统一 client

- `OctopusClient` 由外部注入 token provider（Zustand auth store），
  所有组件共享单例；`createClient()` 工厂默认同源，tui 传自定义
  `baseUrl`。
- 方法组织：基础接口方法 + `ext: ExtClient`（直接请求 `/ext/*`，
  不探测）+ `skills` / `mcp` 配置客户端。
- `tentacle/src/types.ts` 是 web/tui 共享契约的单点定义。

## 6. 配置管理：skill/mcp 跨端抽象

**矛盾**：配置源真相是本地文件系统（`~/.deepagents/`、项目
`.mcp.json`、内置目录）；web 经 server 写文件在分离部署时两端不一致。

**设计**：

- 配置来源带 `origin` 字段：`builtin | file | user-defined`。
  file/builtin → 只读展示（`editable: false`）；user-defined → 可
  增删改，存 **server DB**（非文件），web/tui 经 HTTP 读写同一份，
  天然同步。同名优先级 `user-defined > file > builtin`。
- **core 只出纯函数 + 类型**（`tagFileSkills` / `mergeSkillEntries` /
  `buildUserSkillContent` 等 + `SkillEntry` / `McpServerEntry`），
  零 DB 依赖、不引入 store；合并/读写编排在 **server service 层**
  （`skill.service` / `mcp.service` / `config-store.db`）。
- **agent 运行时接入**：`makeGraph` options 的 `extraSkills` /
  `extraMcpServers` 注入参数——server 从 DB 读 user-defined 后注入，
  `agent.ts` 不感知 DB，最小侵入。
- **tui 兼容**：文件源直接调 core 读本地；user-defined 经 HTTP；
  用 core 纯函数合并展示。server 不可达时降级为仅本地文件源。
  tui 的写入也走 HTTP，与 web 同路。

### 不做的事（范围控制）

- 不引入多进程/分布式 checkpointer（单进程 MemorySaver + SQLite 现状）。
- 不做 DB 引擎迁移，不动 auth 模块。
- 不让 web/tui 直接编辑文件源，不把文件源同步进 DB，不做文件变更监听。
- 不做 user-defined 配置的版本/历史（简单 upsert）。
