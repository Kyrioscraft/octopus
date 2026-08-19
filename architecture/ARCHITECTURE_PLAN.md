# Octopus — core/server 抽象优化与多 UI 兼容总体方案

> 状态：已批准（总体设计）。实施按 §8 的 Phase A–E 分阶段推进。
> 日期：2026-07-22

---

## 0. 404 根因说明

web 请求 `/api/chat/threads` 返回 404，**不是路由拼写/注册问题**：

- `server/src/routes/chat.ts:353` 注册了 `chatRouter.get("/threads", ...)`，挂在 `/api/chat` 前缀下 → 完整路径 `GET /api/chat/threads`。
- `server/dist/routes/chat.js:293` 同样包含该注册（dist 已编译）。
- `tentacle/dist/client.js:50` `listThreads()` 请求的正是 `GET /api/chat/threads`。
- 三者路径**完全对齐**。

真正的根因是 **运行时与产物不同步**：

- **最可能**：当前运行的 server 进程是用加入 `/threads` 之前的**旧 `server/dist`** 启动的，进程未重启 → Hono 找不到该路由返回 404。
- **次可能**：以生产/静态方式打开了 **7/13 的过期 `web/dist`**（`web/dist/assets/index-CSvPkGhW.js` 早于 threads 功能引入）。

**修复动作**（Phase A 一并执行）：

```bash
cd server && npm run build && npm start        # 重建并重启，加载含 /threads 的 dist
cd web && npm run build                         # 重建前端 bundle
# dev 模式：确保 vite(5173) + server(5050) 同时运行
```

§8 Phase E 会加一条**构建一致性校验**，从流程上根治此类"产物漂移"。

---

## 1. 设计目标与原则

| 目标 | 衡量标准 |
|---|---|
| 服务接口精简、功能清晰 | 单一职责；每个 HTTP 端点可一句话描述；契约类型单点定义 |
| 多 UI 共用、兼容性好 | web 与 tui 共用同一套**基础接口**，行为一致；契约变更不破坏旧客户端 |
| 特化功能兼容 | UI 特有能力（附件、反馈、agent 配置）走**扩展路径分组**（`/api/chat/ext/*`），不污染基础接口 |
| core/server 分层干净 | core 暴露稳定的**引擎接口**（`AgentEngine`，见 §3），server 是其 HTTP 适配层，未来可换 agent 运行时 |

**核心原则：core 引擎接口化 + 基础接口/扩展路径分组。**

特化功能（附件、反馈等）**不引入运行时能力探测/自描述机制**——用路径前缀分组 + 404 即可表达"可选、不稳定"，理由见 §5.3。

---

## 2. 三层架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层  (web / tui / 未来更多)                                │
│  只依赖 @octopus/tentacle 的 OctopusClient + 类型契约          │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP (REST 基础 + NDJSON 流 + /ext/* 扩展)
┌────────────────────────▼────────────────────────────────────┐
│  server 层  (@octopus/server)                                │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ routes/     │→ │ services/    │→ │ core 引擎调用      │   │
│  │ (HTTP 适配) │  │ (业务编排)   │  │  + db 持久化       │   │
│  └─────────────┘  └──────────────┘  └────────────────────┘   │
│  routes 只做：参数校验、调用 service、流/JSON 编码             │
└────────────────────────┬────────────────────────────────────┘
                         │ TS 接口调用 (引擎契约)
┌────────────────────────▼────────────────────────────────────┐
│  core 层  (@octopus/core)                                    │
│  暴露 AgentEngine 接口 + 标准化事件 + 各能力模块               │
│  零 HTTP 依赖（现状已满足）                                    │
└─────────────────────────────────────────────────────────────┘
```

分层依赖方向严格不变：`web → tentacle`、`server → core`，禁止反向。

---

## 3. core 层：抽象为引擎接口

当前 `makeGraph()`（`core/src/agent.ts`，~250 行单函数）同时做 model 构建、工具加载、backend 装配、middleware 组装、prompt 生成、HITL 配置、subagent/skill 发现。server 只能整体调用、无法按能力组合。重构方向：**把 core 的公共能力收敛为少量明确的引擎接口**，server 依赖接口而非具体实现。

### 3.1 新增 `core/src/engine.ts` —— AgentEngine 引擎门面

```ts
// core 暴露的引擎接口（接口，非具体类）
export interface AgentEngine {
  /** 编译/取缓存 graph，返回可流式运行的 agent + subagent 注册表 */
  resolve(config: ServerConfig, opts?: {
    cwd?: string;
    mcpConfigPath?: string;        // 额外 MCP 配置文件（现有）
    extraSkills?: SkillEntry[];    // server 注入的 user-defined skill（见 §11.4）
    extraMcpServers?: Record<string, unknown>;  // server 注入的 user-defined mcp
  }): Promise<CompiledAgent>;
  /** 流式运行一轮对话，产出标准化 AgentEvent */
  stream(input: AgentRunInput): AsyncIterable<AgentEvent>;
  /** 一次性标题生成（独立于 graph，复用 buildChatModel） */
  generateTitle(userMessage: string, modelSpec?: string): Promise<string | null>;
  /** 配置变更后清缓存 */
  invalidate(config?: ServerConfig): void;
}
```

- `makeGraph()` 降级为内部实现细节（保留 `createAgent` 作为 deprecated 别名），不再是 server 的主入口。
- server 只依赖 `AgentEngine` 接口 → **未来可替换为不同 agent 运行时（如远程沙箱、多模型路由）而不动 server**。

### 3.2 标准化事件模型 `AgentEvent`

当前 server 在 `chat.ts` 里手工把 LangGraph 的原始事件翻译成 NDJSON chunk，逻辑与 HTTP 耦合。core 应产出**运行时无关的标准化事件**，server 只负责"序列化为 NDJSON"：

```ts
// core 产出的引擎事件（与传输协议解耦）
export type AgentEvent =
  | { type: "init"; requestId: string; threadId: string }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; args: unknown; id: string }
  | { type: "tool_result"; toolCallId: string; content: unknown; isError?: boolean }
  | { type: "subagent_started"; agentNs: string; description: string }
  | { type: "interrupt"; questions: unknown[]; actionRequests: unknown[]; source: string }
  | { type: "finished"; usage?: Record<string, unknown> }
  | { type: "error"; errorType: string; message: string };
```

收益：HITL 中断处理、partial message 保存、subagent 渲染等逻辑从 server 下沉到 core，server 的 `chat.ts` 从 466 行收缩到纯传输层。

### 3.3 core 内部清理（顺带）

- `system_prompt.md` 与 `prompts.ts` 内联模板内容重复，且 `system_prompt.md` **当前未被运行时引用** → 删除（或让 `prompts.ts` 真正读取它），消除维护漂移。
- `ShellAllowListMiddleware` 已实现并导出，但 `agent.ts` 未挂载 → 在 `AgentEngine.resolve` 中按 `Settings.shellAllowList` 接通。
- 修正注释：多处误称 `config.toml`，实际格式是 `~/.deepagents/config.json`。

---

## 4. server 层：引入 service 层 + 精简路由

当前 `chat.ts`（466 行）混了业务编排 / 流处理 / HITL / DB 调用 / 标题生成。拆分为 **routes（HTTP 适配）+ services（业务编排）+ db（数据访问，已存在）**。

### 4.1 目录结构

```
server/src/
├── app.ts                      # 路由挂载、中间件链（不变）
├── main.ts                     # 启动（不变）
├── routes/
│   ├── auth.ts                 # 保持
│   ├── chat.ts                 # 瘦身后：仅 HTTP 适配，调 ChatService / ThreadService
│   ├── config.ts               # 【新】skill/mcp 配置管理（见 §11）
│   └── ext.ts                  # 【新】扩展功能路由（纯路径前缀分组，见 §5.2）
├── services/                   # 【新】业务编排层
│   ├── thread.service.ts       # 会话 CRUD + 显式创建 + 标题
│   ├── chat.service.ts         # 编排：engine.stream → AgentEvent → 持久化 → NDJSON
│   ├── skill.service.ts        # 【新】编排 skill 配置（读文件+读DB+合并，见 §11）
│   ├── mcp.service.ts          # 【新】编排 mcp 配置（同上，见 §11）
│   └── config-store.db.ts      # 【新】user-defined 配置的 DB CRUD（见 §11）
├── db/                         # 数据访问（已存在，保持；§11 新增 user_skills / user_mcp_servers 表）
└── auth/                       # 保持
```

### 4.2 service 职责

- **`thread.service`**：`listThreads / getThread / createThread(title?, agentId?) / renameThread / deleteThread / getHistory`。封装 db 调用 + 业务规则（如新会话标题默认值"新对话"）。**补齐当前缺失的显式创建会话能力**（见 §5.1）。
- **`chat.service`**：消费 `AgentEngine.stream()` 的 `AgentEvent`，负责：① 持久化 user/assistant 消息（含 reasoning_content，修复当前丢失 bug）；② 翻译 `AgentEvent → NDJSON StreamEvent`；③ 处理客户端断连的 partial 保存；④ new thread 的标题生成触发并把标题塞进 `finished` 事件。**所有协议序列化集中在此，路由层不再关心。**

### 4.3 路由层（瘦身后）职责

`routes/chat.ts` 每个处理器只做三件事：

1. 解析 + 校验请求参数（Hono `c.req.json/param/query`）。
2. 调用对应 service 方法。
3. 把结果编码为 JSON 或 NDJSON 流返回。

不再包含业务规则、不再直接调 db、不再手工翻译 LangGraph 事件。

---

## 5. API 设计：基础接口 + 扩展路径分组

### 5.1 基础接口（所有 UI 共用，精简稳定）

收敛到 **7 个端点**，语义对 web/tui 完全一致：

| 方法 | 路径 | 功能 | 形式 |
|---|---|---|---|
| `GET` | `/api/chat/threads` | 会话列表（预留 `?cursor&limit` 分页） | JSON |
| `POST` | `/api/chat/threads` | **【新】显式创建会话**（body: `{title?, agent_id?}`），返回 `{thread}` | JSON |
| `GET` | `/api/chat/thread/:id/history` | 历史消息 | JSON |
| `DELETE` | `/api/chat/thread/:id` | 删除会话 | JSON |
| `PUT` | `/api/chat/thread/:id` | 重命名（body: `{title}`） | JSON |
| `POST` | `/api/chat/agent` | 发消息，流式回复 | NDJSON |
| `POST` | `/api/chat/thread/:id/resume` | HITL 恢复 | NDJSON |

**配置资源域**（`/api/config/*`，web/tui 共用的基础能力，详见 §11）：

| 方法 | 路径 | 功能 |
|---|---|---|
| `GET` | `/api/config/skills` | 列出所有 skill（file+builtin+user-defined，带 origin/editable） |
| `GET` | `/api/config/skills/:name` | 查看 skill 内容 |
| `POST` / `PUT` / `DELETE` | `/api/config/skills[/:name]` | 仅 user-defined 可增删改，file/builtin 返回 409 |
| `GET` | `/api/config/mcp` | 列出所有 MCP server（带 origin/enable/status，`?probe=true` 探测连接） |
| `POST` / `PUT` / `DELETE` | `/api/config/mcp[/:name]` | 仅 user-defined 可增删改 |
| `PUT` | `/api/config/mcp/:name/enabled` | 启用/禁用（任意 origin，复用 setServerDisabled） |

**契约改进（修复现有 gap）**：

- `POST /agent` 的 `finished` chunk 携带 `meta.title`（新会话标题生成后）→ 消除前端 `setTimeout(listThreads,3000)` 轮询 hack。
- 持久化 `reasoning_content` 到 `messages.extra_metadata` → 修复刷新后 reasoning 丢失（当前 `saveAiMessages` 未写入该字段，而 `Chat.tsx` 从 `extraMetadata.additional_kwargs.reasoning_content` 读取）。
- 统一字段名：`ChatRequest.agent_id: string`（去掉 tentacle 里未用的 `agent_config_id?: number`，消除类型不一致）。

### 5.2 扩展路径分组 `/api/chat/ext/*`（UI 特化功能）

**任何 UI 特有、非通用必备的能力**一律放 `/api/chat/ext/*`，不进基础接口。规则：

- `/ext/*` 前缀本身就是"这些端点可选、稳定性低于基础接口"的信号，**不引入运行时探测**。
- 没实现的扩展功能，前端**直接不调用**（monorepo 同步发布，编译期即知哪些接口存在）。
- 调用了未实现/被关闭的扩展端点 → 返回标准 HTTP 404，客户端按需 catch（一般就是隐藏对应 UI 元素），**不要求统一的降级链路**。
- 基础接口字段**绝不因扩展而变更**。

已识别的扩展候选（web 需要、tui 不需要）：

| 方法 | 扩展路径 | 功能 |
|---|---|---|
| `POST` | `/api/chat/ext/message/:id/feedback` | 消息点赞/点踩（`feedback` 字段已在 schema） |
| `POST` | `/api/chat/ext/upload` | 附件/图片上传 |
| `GET` | `/api/chat/ext/agents` | agent/subagent 配置列表（Sidebar 已渲染 UI 但无后端） |
| `PUT` | `/api/chat/ext/thread/:id/agent` | 切换会话 agent |

### 5.3 不引入能力探测机制（决策记录）

**刻意不采用** "服务端自描述能力清单 + 客户端探测 + 优雅降级" 这套模式。理由：

- 该模式适用于**多方独立部署、能力开放集合、无法同步发布**的场景（如 K8s API、MCP server、插件生态）。
- octopus 是**单仓库、单团队、前后端同步发布**，能力集合是封闭的、编译期已知的。运行时探测等于为一个不存在的"部署差异"背上探测-缓存-降级-一致性维护的全套成本。
- 现在没做的扩展（feedback/upload/agents）是 **roadmap 缺口**，不是"运行时不确定性"，用路径前缀分组 + 404 足以表达。

**何时重新引入**：当出现独立的第三方部署（关掉某些功能），或多 UI 差异大到无法同步发布时，再加能力探测。在那之前遵循 YAGNI。

---

## 6. tentacle 层：统一 client

### 6.1 单例化与 token 统一

当前 `Chat.tsx` 与 `Sidebar.tsx` 各 `new OctopusClient()`、token 不共享（且当前都没 login，依赖 server 的 `getOptionalUser` dev-user 回退）。改为：

- `OctopusClient` 支持**外部注入 token provider**（如一个 Zustand auth store），所有组件共享同一实例。
- 提供 `createClient()` 工厂（默认同源），tui 传入自定义 `baseUrl`。

### 6.2 client 方法组织

```ts
class OctopusClient {
  // 基础接口（稳定）
  listThreads(): Promise<Thread[]>;
  createThread(opts?: { title?: string; agentId?: string }): Promise<Thread>;   // 【新】
  getThreadHistory(id: string): Promise<MessageRow[]>;
  deleteThread(id: string): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
  streamAgentChat(body: ChatRequest, opts?: StreamCallOptions): AsyncIterable<StreamEvent>;
  streamAgentResume(id: string, approved: boolean, opts?: StreamCallOptions): AsyncIterable<StreamEvent>;

  // 扩展接口（直接调用对应 /ext/* 端点，不做能力探测）
  ext: ExtClient;   // ext.feedback(id, rating), ext.upload(file), ext.listAgents() ...

  // 配置管理接口（基础能力，web/tui 共用，见 §11）
  skills: SkillClient;   // skills.list(), skills.get(name), skills.create(), skills.update(), skills.remove()
  mcp: McpClient;        // mcp.list({probe}), mcp.create(), mcp.update(), mcp.remove(), mcp.setEnabled(name, on)
}
```

- `ExtClient` 方法**直接请求** `/api/chat/ext/*`，不预先探测能力。
- 未实现/被关闭的扩展端点返回 HTTP 404，调用方按需 catch（一般就是隐藏对应 UI 元素），**无统一的降级链路**。
- 是否渲染某个扩展 UI，由前端自身的 feature flag 或"该接口是否已实现"决定，而非运行时探测。

### 6.3 契约单点化

`tentacle/src/types.ts` 已是 web/tui 共享契约（现状良好）。补充：

- 修正 `ChatRequest`（`agent_config_id?` → `agent_id?: string`）与 server 对齐。
- `StreamEvent` 枚举收敛到 server 实际产出的子集（`agent_state` / `interrupted` / `warning` 文档化为保留值，未实现时客户端忽略，不报错）。
- **不新增**任何能力探测相关的类型。
- 新增配置管理类型：`SkillEntry` / `McpServerEntry` / `SkillOrigin` / `McpOrigin`（见 §11.1，web/tui 共享）。

---

## 7. 数据层小幅增强（配合 API）

`server/src/db/schema.ts` 已是 Drizzle + better-sqlite3（**优于 AGENTS.md 描述的 JSON 文件，注释已过时**，Phase E 修正）。配合本方案：

- `messages.extra_metadata` 写入 `reasoning_content`（修 bug）。
- `listThreads(userId)` 支持分页参数（`cursor/limit`），为未来大列表预留。
- 预留 `thread.agent_id` 已存在，配合 `ext/thread/:id/agent` 切换。
- **不引入多进程安全假设**（保持单进程 MemorySaver + SQLite 现状，水平扩展为后续阶段）。

---

## 8. 迁移步骤（分阶段，低风险）

每阶段可独立验证、独立合入。

1. **Phase A — 契约统一（不破坏）**：tentacle 修正 `ChatRequest` 字段；server `chat.ts` 的 `finished` 带 `meta.title`；持久化 `reasoning_content`。重建 dist，重启 server（顺带验证 404 根因消除）。
2. **Phase B — 抽 service 层**：从 `chat.ts` 提取 `thread.service` / `chat.service`，路由改为薄适配。行为不变，纯结构重构，靠现有手测回归。
3. **Phase C — core 引擎接口化**：引入 `engine.ts` + `AgentEvent`，让 `chat.service` 消费标准化事件；`makeGraph` 降级为内部函数。下沉 HITL / partial 保存逻辑到 core。
4. **Phase D — 扩展路由分组**：新增 `routes/ext.ts`，把 `feedback/upload/agents` 从"无后端的 UI"迁入 `/api/chat/ext/*` 端点；tentacle 加 `ExtClient` 直接调用。
5. **Phase E — 清理**：删 `system_prompt.md` 死代码、接通 `ShellAllowListMiddleware`、修正 AGENTS.md 关于 DB 格式的过时注释、加构建一致性校验（CI 或 prebuild 脚本检查 `src` 与 `dist` 同步）。
6. **Phase F — config 基础设施**（见 §11）：core 新增纯工具函数（`tagFileSkills`/`mergeSkillEntries`/`buildUserSkillContent` 等）+ 类型（`SkillEntry`/`McpServerEntry`/`SkillOrigin`/`McpOrigin`），**不引入 store、不改现有函数**；server 新增 `user_skills`/`user_mcp_servers` 表 + `config-store.db.ts`（DB CRUD）+ `routes/config.ts` + `skill.service`/`mcp.service`（编排逻辑集中于此）。先只实现 list + get（只读），验证 file 源经 service 透传正确。
7. **Phase G — 可写 + 跨端同步**（见 §11）：实现 create/update/delete（user-defined）+ setEnabled（复用 setServerDisabled）；`makeGraph` options 新增 `extraSkills`/`extraMcpServers` 注入参数，`chat.service` 调用前从 DB 读 user-defined 注入（agent 加载链路最小改动，详见 §11.4）；tentacle 加 `skills`/`mcp` 客户端方法 + 类型；web 补"扩展管理"页面（区分 file 只读 vs user-defined 可编辑）；tui 的 mcp-viewer/skill 列表接入 HTTP user-defined 源 + 本地 file 源合并。

---

## 9. 兼容性保证矩阵

| 场景 | 保证 |
|---|---|
| 旧 web bundle 打新 server | 基础接口路径不变 → 可用；扩展端点旧 bundle 不调 → 无影响 |
| 新 web bundle 打旧 server | 调用未实现的 `/ext/*` → 404，前端按需隐藏对应 UI；基础接口照常 |
| tui 与 web 共存 | 共用基础接口 + 共享类型；tui 不调扩展 → 自动忽略 |
| core 运行时替换 | server 依赖 `AgentEngine` 接口，换实现不动 HTTP 契约 |
| web/tui 分离部署（配置同步） | user-defined 配置经 server DB 同步；文件源各端读各本地（见 §11） |
| tui 离线（server 不可达） | 降级为仅本地文件源，user-defined 列表为空，不报错（见 §11） |

---

## 10. 不做的事（范围控制）

- 不引入多进程/分布式 checkpointer（后续阶段）。
- 不做 DB 迁移到其它引擎（SQLite 现状够用）。
- 不动 auth 模块（JWT + argon2 现状良好）。
- 不实现扩展端点的全部业务（仅定义契约 + 最少实现，如 feedback/upload 具体逻辑按需补）。
- 不引入运行时能力探测/自描述机制（见 §5.3 决策）。
- 不让 web 直接编辑文件源 skill/mcp（保持文件源只读，见 §11.10）。
- 不把文件源同步进 DB、不引入文件变更监听（见 §11.10）。

---

## 11. 配置管理：skill/mcp 跨端抽象

### 11.0 约束与设计取向（本次修订的核心）

实现约束（已确认，高于一切）：
1. **现有代码尽量少调整**——尤其 core 的 agent 构建流水线（`agent.ts` 的 `makeGraph`/`listSkills` 调用链）。
2. **server 层解决 web/tui 的交互逻辑**——配置管理的编排（合并多源、读写 DB、HTTP 适配）是 server 的职责。
3. **core 层抽象可复用、结构清晰、暴露接口稳定**——core 只提供纯工具函数 + 类型，不承载编排逻辑、不引入 DB 依赖。

由此导出本次修订相对初版的关键调整：
- ~~core 提供 SkillStore/McpStore 接口~~ → **core 不再有 store**。store 的编排逻辑（合并 file+user-defined、读写 DB）全部落在 **server 的 service 层**。
- core 的产出收敛为：**纯工具函数 + 类型定义**（见 §11.3），保持 core 纯净、零 DB 依赖。
- agent 运行时接入 user-defined 的方式，从"依赖 store"改为 **`makeGraph` options 增加注入参数**（见 §11.4），是对现有加载链路的最小侵入式扩展。

### 11.1 问题与设计意图

**矛盾**：skill/mcp 的配置源真相是本地文件系统（`~/.deepagents/`、项目 `.mcp.json`、内置目录），core 现有函数（`listSkills`/`loadMcpConfig`/`setServerDisabled`）全部直接读写这些文件。tui 本地运行直读没问题；web 经 server 写入时写的是 server 机器的文件，分离部署时两端看到不同配置。

**设计意图**（已确认）：
1. 支持 **web/tui 配置同步**（可能分离部署）。
2. 配置来源分两类：
   - **文件源**（`.mcp.json`、`SKILL.md`、内置）→ web 里**只读展示**，标记为"内置/文件"。
   - **web 界面创建的**（用户自定义）→ **可增删改**，标记为"用户定义"，且**要能被 agent 运行时实际使用**。

### 11.2 统一的配置来源模型：`origin` 字段

所有 skill/mcp 条目统一带 `origin` 字段，标识来源、决定可写性：

```ts
type SkillOrigin = "builtin" | "file" | "user-defined";
type McpOrigin   = "file" | "user-defined";

interface SkillEntry extends SkillMetadata {
  origin: SkillOrigin;        // builtin/file → 只读; user-defined → 可增删改
  editable: boolean;          // = (origin === "user-defined")
  description: string;
  // file/builtin 源额外带 path/source；user-defined 源带存储 id
}

interface McpServerEntry {
  name: string;
  origin: McpOrigin;
  editable: boolean;
  transport: "stdio" | "sse" | "http" | "streamable-http";
  config: Record<string, unknown>;   // command/args/env 或 url 等
  enabled: boolean;                   // 禁用状态（复用现有 setServerDisabled）
  status?: MCPServerStatus;           // 连接状态（仅 list 时实时探测填充）
}
```

**规则**：
- `origin === "file" | "builtin"` → `editable: false`，只展示，改它要去改对应文件。
- `origin === "user-defined"` → `editable: true`，可经 API 增删改。
- 同名时优先级：`user-defined > file > builtin`（与现有 skills 的"高优先级覆盖低优先级"一致）。

### 11.3 core 层：只出工具函数 + 类型（不引入 store）

core 的新增产出**严格限定为无状态纯函数 + 类型定义**，从 `core/src/index.ts` 导出，server 和 tui 都可直接复用：

```ts
// —— 类型（web/tui/server 共享契约）——
export type SkillOrigin = "builtin" | "file" | "user-defined";
export type McpOrigin = "file" | "user-defined";
export interface SkillEntry extends SkillMetadata { origin; editable; ... }
export interface McpServerEntry { name; origin; editable; transport; config; enabled; status?; }

// —— 纯工具函数（无 I/O 副作用，易测试）——
/** 把 file 源的 SkillMetadata[] 标记为 origin="file"|"builtin" */
export function tagFileSkills(skills: SkillMetadata[], builtinNames: Set<string>): SkillEntry[];
/** 合并 file 源 + user-defined 源，user-defined 覆盖同名（纯内存运算） */
export function mergeSkillEntries(file: SkillEntry[], userDefined: SkillEntry[]): SkillEntry[];
/** 生成 user-defined skill 的 SKILL.md 内容（不落盘，落盘由 server 负责） */
export function buildUserSkillContent(name: string, description: string, body: string): string;
/** 同理：MCP 合并/标记 */
export function tagFileMcpServers(...): McpServerEntry[];
export function mergeMcpEntries(file: McpServerEntry[], userDefined: McpServerEntry[]): McpServerEntry[];
```

**core 现有函数全部保留不动**（这是"现有代码少调整"的体现）：
- `listSkills` / `loadSkillContent` / `validateSkillName` / `generateSkillTemplate` → 原样，server service 调它们读文件源。
- `loadMcpConfig` / `mergeMcpConfigs` / `discoverMcpConfigs` / `resolveAndLoadMcpTools` → 原样。
- `setServerDisabled` / `trustProjectMcp` / `revokeProjectMcpTrust` → 原样，server service 调它们处理禁用/信任。

**core 不新增**：store 接口、DB backend 接口、任何带 DB/HTTP 依赖的东西。`config_store.ts` **不创建**。

### 11.4 agent 运行时接入 user-defined：options 注入（最小改动）

`makeGraph` 的 `options` 已有 `mcpConfigPath` 参数（`agent.ts:341`，注释提到 `data/.web-mcp.json`）——这天然就是"额外配置注入"的挂载点。扩展它为显式注入参数：

```ts
export async function makeGraph(config: ServerConfig, options?: {
  mcpConfigPath?: string;        // 保留（现有）
  cwd?: string;                  // 保留（现有）
  /** server 注入的 user-defined skill（来自 DB），与文件源合并后供 agent 使用 */
  extraSkills?: SkillEntry[];    // 【新增】
  /** server 注入的 user-defined mcp server 配置，合并进 mcpServers */
  extraMcpServers?: Record<string, unknown>;  // 【新增】
}): Promise<CompiledAgent> { ... }
```

**对 `agent.ts` 内部的改动是最小侵入式**：
- skills 加载处（`agent.ts:499` 的 `listSkills(...)`）**调用本身不动**，只是在拿到 `skillsList` 后追加：
  ```ts
  const fileSkills = tagFileSkills(skillsList, builtinNameSet);
  const allSkills = options?.extraSkills ? mergeSkillEntries(fileSkills, options.extraSkills) : fileSkills;
  // 后续 createDeepAgent 用 allSkills（skillSourcePaths 的构建逻辑对 user-defined 项做兼容处理）
  ```
- mcp 加载处同理，把 `extraMcpServers` 合并进 `mergeMcpConfigs` 的结果。
- **缓存 key**（`_cacheKey`）要把 `extraSkills`/`extraMcpServers` 的签名纳入，避免不同 user-defined 配置命中同一缓存。

这样 server 在调 `makeGraph` 时，先从 DB 读出当前用户的 user-defined skill/mcp，经 `extraSkills`/`extraMcpServers` 注入——**agent.ts 不感知 DB，不依赖 store，只多接两个可选参数**。user-defined 的 skill/mcp 因此能被 agent 实际使用，且改动局限在加载处几行。

### 11.5 server 层：config 领域（编排所在地）

```
server/src/
├── routes/config.ts              # 薄 HTTP 适配 → 调 service
├── services/
│   ├── skill.service.ts          # 编排: 读文件(调core listSkills) + 读DB + 合并(调core merge) + 写DB
│   ├── mcp.service.ts            # 编排: 同理; list 带 probe 时调 resolveAndLoadMcpTools
│   └── config-store.db.ts        # user-defined 的 DB CRUD (Drizzle)
└── db/schema.ts                  # 新增 user_skills / user_mcp_servers 表
```

service 的职责（编排逻辑集中于此，不在 core、不在 route）：
- `list()`：`listSkills()`（core，读文件）→ `tagFileSkills()`（core，标记）→ DB 读 user-defined → `mergeSkillEntries()`（core，合并）→ 返回。
- `create()`：`validateSkillName()`（core）→ `buildUserSkillContent()`（core）→ 写 DB。
- `update()`/`remove()`：仅对 user-defined（DB），file 源返回 409。
- `setEnabled()`：调 core 现有 `setServerDisabled()`（写 config.json，运行时状态）。
- `chat.service` 在调 `makeGraph` 前，从 DB 读当前用户 user-defined skill/mcp，经 `extraSkills`/`extraMcpServers` 注入。

DB 新增两表（按 `userId` 隔离、unique 防同名）：

```ts
export const userSkills = sqliteTable("user_skills", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  content: text("content").notNull(),          // SKILL.md 全文
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({ uniq: uniqueIndex("us_user_name").on(t.userId, t.name) }));

export const userMcpServers = sqliteTable("user_mcp_servers", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  transport: text("transport").notNull(),
  config: text("config").notNull(),            // JSON
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => ({ uniq: uniqueIndex("um_user_name").on(t.userId, t.name) }));
```

**关键决策：user-defined 源存 DB，不存文件**——web 经 server 读写 DB，tui 经 HTTP 读同一份 DB，天然同步；分离部署时两端 user-defined 一致。文件源保持只读不动（各端读各本地）。

### 11.6 API 设计（见 §5.1 配置资源域表）

- 对 file/builtin 源做 POST/PUT/DELETE → `409 {error:"not_editable", origin:"file"}`，提示"来自文件，请直接编辑文件"。
- `GET /api/config/mcp?probe=true` 时 service 调 `resolveAndLoadMcpTools` 实时探测连接状态。
- **不归入 §5.2 的 `/ext/*`**：skill/mcp 是 web 和 tui 都需要的基础能力，非 web 特有扩展。放 `/api/config/*` 独立资源域。

### 11.7 tui 的兼容接入

tui 有两条数据路径，自然兼容：
1. **文件源**（builtin/file）→ 直接 `import @octopus/core` 的 `listSkills`/`loadMcpConfig` 读本地文件（快、离线可用）。
2. **user-defined 源**（DB）→ 经 HTTP（tentacle 的 `skills.list()`/`mcp.list()`）读 server DB，与 web 同步。

**合并视图**：本地文件源 + HTTP user-defined 源各拉一份，用 core 的 `mergeSkillEntries`/`mergeMcpEntries` 合并（tui 也能直接用这些纯函数），展示带 origin 标记。server 不可达时降级为仅本地文件源（离线韧性）。

**tui 的写入**：不直接写 user-defined（避免绕过 server 不同步）——创建 skill/mcp 也经 HTTP POST 到 server，和 web 同一条路。文件源仍由用户手动编辑文件（tui 面向开发者，手改文件是常态）。

这样 **web 和 tui 对 user-defined 配置永远一致**（都读写同一份 server DB），文件源各读各的本地。

### 11.8 现状参照（实施时的起点）

- **core**：`listSkills`/`loadSkillContent`/`validateSkillName`/`generateSkillTemplate`（只读发现）、`loadMcpConfig`/`mergeMcpConfigs`/`discoverMcpConfigs`/`resolveAndLoadMcpTools`（只读+连接）、`setServerDisabled`/`trustProjectMcp`（已导出但无调用方）。**缺**合并/标记的纯函数和 `SkillEntry`/`McpServerEntry` 类型——这些是本次新增。
- **server**：`routes/` 只有 `auth.ts`+`chat.ts`，**零 skill/mcp 路由**。
- **tentacle**：`OctopusClient` **零 skill/mcp 方法**。
- **web**：`AgentConfigSidebar.tsx:82` 只有一个静态"MCP 服务器"占位标签；Sidebar 的"扩展管理"是死链 `/extensions`（无路由）。**完全没开始**。
- **tui**：`cli.ts` 的 `skills` 命令调 core 只读列出；`mcp-viewer.tsx` 调 `loadMcpConfig`（疑似读 `config.servers` 而非 `config.mcpServers` 的字段名 bug）；交互式 TUI 的 skill 自动补全无数据源。

### 11.9 兼容性与边界

| 场景 | 行为 |
|---|---|
| web 改不了文件源 skill | API 返回 409 + origin 标记，UI 灰显编辑按钮，提示"来自文件" |
| tui 离线（server 不可达） | 降级为仅本地文件源，user-defined 列表为空，不报错 |
| 同名 file + user-defined | user-defined 覆盖展示；agent 加载时取 user-defined 版本（经 extraSkills 注入） |
| 分离部署 | user-defined 经 DB 同步（web/tui 读同一份）；文件源各端读各本地（符合预期） |
| 禁用状态 | 任意 origin 的 server 都可禁用（写 config.json，运行时状态），不改源定义 |
| core 纯净性 | core 零 DB/HTTP 依赖，只新增纯函数+类型，现有函数一行不改 |

### 11.10 迁移（见 §8 Phase F–G）

- **Phase F**：core 加纯函数+类型；server 加 DB 表 + service + route，先只读 list/get。
- **Phase G**：可写（create/update/delete）+ setEnabled + `makeGraph` options 注入 + tentacle 客户端 + web 页面 + tui 合并视图。

### 11.11 不做的事（配置管理范围控制）

- 不在 core 引入 store 接口或 DB backend（core 只出纯函数+类型）。
- 不让 web 直接编辑文件源（保持文件源只读，避免 web 写 server 机器文件造成混乱）。
- 不把文件源同步进 DB（文件源各端本地，DB 只存 user-defined）。
- 不引入文件变更监听（file 源变更靠重启或手动刷新 list 感知，不做 watch）。
- 暂不做 user-defined 的版本/历史（简单 upsert 即可）。
