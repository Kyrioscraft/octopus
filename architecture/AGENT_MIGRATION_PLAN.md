# Octopus 智能体化改造实施计划

> **状态（2026-08-18）：阶段 1–3 已实施完成，阶段 4 部分完成。**
> 实施中的实际取舍与原计划的差异见文末"实施记录"一节。
>
> 将 AccessMode（plan/confirm/auto/full）模式系统演进为 opencode 式
> "主智能体 + 细粒度权限规则"架构。
>
> 调研基准：`D:\workstation\opensource\opencode-dev`（sst/opencode）

---

## 背景：opencode 的设计要点

**模式 = 智能体配置**。没有独立的"模式"概念，一切差异（工具集、审批策略、
提示词）都收敛为 agent 的两个字段：

1. **细粒度 permission Ruleset**：

   ```ts
   // plan agent 的关键配置（packages/opencode/src/agent/agent.ts:156-181）
   permission: {
     edit: { "*": "deny", ".opencode/plans/*.md": "allow" }, // 只能写计划文件
     task: { general: "deny" },                              // 只留 explore 子代理
     plan_exit: "allow",
   }
   ```

   每条规则是 `allow / ask / deny`，按 glob pattern 匹配工具+参数（如具体
   文件路径），`findLast` 求值（后面的规则覆盖前面），未匹配默认 `ask`。

2. **双层生效机制**：
   - **静态**：`deny` 且 pattern 为 `*` 的工具直接从 LLM 工具列表移除
     （模型根本看不到）；
   - **动态**：其余工具执行时 `Permission.ask()` 求值 → allow 放行 /
     deny 抛错 / ask 挂起等用户回复（once / always / reject+反馈，
     `always` 写入 session 级规则）。

3. **agent 绑定在消息级，不是 session 级**：同一会话每条 user 消息携带
   `agent` 字段，切换 agent 不新建会话、不清历史，Tab 循环只是客户端状态。

4. **plan→build 切换**：`plan_exit` 工具弹确认，批准后注入一条 synthetic
   user 消息（`agent: "build"`，"Execute the plan"）。

### octopus 现状对照

| opencode 概念 | octopus 现状 | 差距 |
|---|---|---|
| agent 定义(prompt+tools+permission) | `makeGraph(accessMode)` 编译期四档 + `BUILTIN_SUBAGENTS` | permission 只到"工具级 allow/deny"，无 glob pattern、无 ask 中间档 |
| 静态工具移除 | plan 模式剥离 `DESTRUCTIVE_TOOLS` | 已有，但配置硬编码在 config.ts |
| 动态 ask | HITL `interruptOn`（编译期 map + 运行时 override） | 已有，但粒度粗（按工具名，不按参数） |
| 消息级 agent 切换 | thread 级 `accessMode` 持久化 + PATCH mode | 切换粒度在 thread 而非 message |
| always 写回 session 规则 | 前端 `sessionAllowlist`（客户端 hack） | opencode 的做法正是把它下沉为 session 级 Ruleset |
| plan_exit | `submit_plan` / `plan_approval`（已实现） | 基本等价 |

### opencode 关键代码路径

| 功能 | 文件:行 |
|---|---|
| Agent Schema + 内置定义 | `packages/opencode/src/agent/agent.ts:35-265` |
| permission 求值/ask/reply | `packages/opencode/src/permission/index.ts:28-38, 67-167` |
| 工具执行时注入 ask | `packages/opencode/src/session/tools.ts:81-87` |
| 禁用工具静态过滤 | `packages/opencode/src/permission/index.ts:204-219` + `session/llm/request.ts:209-215` |
| plan_exit 切换 build | `packages/opencode/src/tool/plan.ts:25-76` |
| plan 模式提示词 | `packages/opencode/src/session/prompt/plan-mode.txt` |
| Tab 循环 agent | `packages/tui/src/config/keybind.ts:130-131` + `packages/tui/src/context/local.tsx:77-118` |
| session.agent/permission | `packages/opencode/src/session/session.ts:237-242, 424-439` |

---

## 阶段 1：内置 Agent Preset（纯重构，零行为变化）

**目标**：把四档 AccessMode 改写为数据驱动的 agent 定义，UI 从"模式下拉"
改为"智能体选择"，对外协议不变。

### 新增 `packages/core/src/agents/builtin.ts`

```ts
export interface AgentPreset {
  name: string;                    // "plan" | "confirm" | "auto" | "full" | 自定义
  label: string;
  description: string;
  mode: "primary" | "subagent";
  promptBlock: string;             // 替代 dynamic_context_middleware 的 _buildModeBlock switch
  toolFilter: (tool: Tool) => boolean;   // 替代 DESTRUCTIVE_TOOLS 硬编码剥离
  permission: PermissionRuleset;    // 阶段2引入，本阶段先占位为粗粒度 map
}
```

### 改动点

| 文件 | 改动 |
|---|---|
| `core/src/config.ts` | `interruptOnForMode` 改为读 preset.permission 生成 override；`DESTRUCTIVE_TOOLS` 移入各 preset 的 toolFilter |
| `core/src/agent.ts` | `makeGraph(options.accessMode)` → `makeGraph(options.agent)`；graph 缓存键 `modeSignature` 改为 agent 名 + 签名 hash；`_buildModeBlock` 改为拼接 preset.promptBlock |
| `core/src/middleware/dynamic_context_middleware.ts` | 删除 switch，接收 promptBlock 参数 |
| `server/src/routes/chat.ts` | 请求体 `mode` 字段改名为 `agent`（保留 `mode` 兼容映射，两端点：`/agent`、`/thread/:id/mode` → `/thread/:id/agent`） |
| `server/src/db/schema.ts` | threads 表 `access_mode` 列保留，值域即 agent 名（无需迁移，"confirm" 仍是默认） |
| `web/src/components/chat/constants.tsx` | `ACCESS_MODES` → `BUILTIN_AGENTS` 元数据；InputBar 下拉 + Shift+Tab 循环复用现有逻辑 |
| `tentacle/src/types.ts` | `mode?: AccessMode` → `agent?: string`（保留 mode 别名） |

### 用户自定义主智能体（本阶段顺带）

`server` 已有 `userSubagents`（含 `enabled` 字段）——增加 `primary: boolean`
标记，标记为 primary 的用户智能体：

- 加入前端 Tab 循环与下拉
- `makeGraph` 用其 `systemPrompt` 追加 / `tools` 白名单 / `permission` 构建
- 受限于其 tools 白名单（复用 `resolveToolWhitelist`）

**验证**：现有四模式行为逐一冒烟对比（plan 剥离工具、auto 免审、full 绕过
FileEditGuard、submit_plan 流程）。

---

## 阶段 2：Permission Ruleset 引擎（核心架构收益）

**目标**：引入 opencode 式三级权限 `allow / ask / deny` + glob pattern，
替代 `interruptOn` 布尔开关，并把前端 `sessionAllowlist` 下沉到服务端。

### 2.1 新增 `packages/core/src/permission/`（三个文件，对照 opencode 移植）

```
permission/
  types.ts      — Rule { permission, pattern, action }, Ruleset = Rule[]
  evaluate.ts   — evaluate(ruleset, permission, pattern): Rule
                  findLast 匹配，未命中默认 { action: "ask" }
  wildcard.ts   — glob 匹配器（支持 * ** ?，路径归一化 / case-insensitive on win32）
```

配置形式（Zod schema，供用户 TOML/DB 定义）：

```ts
{
  edit: { "*": "deny", "docs/**/*.md": "allow" },
  bash: { "git *": "allow", "*": "ask" },
  webfetch: "ask",
}
```

### 2.2 求值接入点

| 现机制 | 替换为 |
|---|---|
| 编译期 `_addInterruptOn()`（工具名→审批） | `ask` 且 pattern=`*` 的工具编译进 HITL（保持现有 humanInTheLoopMiddleware 用法） |
| 运行时 `interruptOnForMode`（全 false 覆盖） | 运行时注入完整 ruleset，`allow` 生成 `{ tool: false }` 覆盖 |
| plan 的 `toolFilter`（DESTRUCTIVE_TOOLS 剥离） | `deny` + pattern `*` → 静态从工具列表移除（LLM 不可见） |
| `FileEditGuardMiddleware`（shell 写拦截） | 保留为实现细节，但由 `bash` pattern 规则触发（`deny` 时硬拦，`ask` 时转 HITL 审批——这是新增能力：目前 shell 写只有硬拦/放行两态） |
| 前端 `sessionAllowlist` | resume 端点 `always` 决策 → `updateThreadPermission(threadId, rule)` 持久化 thread 级 ruleset，下一审批点自动生效；前端仅展示 |

### 2.3 内置 preset 的 permission 定义（对齐 opencode）

```ts
plan: {
  edit: { "*": "deny", ".octopus/plans/*.md": "allow" },   // 计划文件可写
  task: { general: "deny" },                                // 只留 explore
  bash: { "rg *": "allow", "find *": "allow", "*": "ask" },
  submit_plan: "allow",
}
confirm: { "*": "ask", read: "allow" }
auto:   { "*": "allow" }          // FileEditGuard 仍生效
full:   { "*": "allow", bypassFileEditGuard: true }
```

**注意**：阶段 2 期间 `submit_plan` 流程不变；plan 的
`.octopus/plans/*.md` 可写意味着计划落盘为文件（对齐 opencode），UI 计划
审批面板从 interrupt payload 读计划文本，可后续再改为读文件。

### 2.4 HITL 协议扩展

- interrupt 消息中带上匹配到的 rule 与 pattern（UI 显示"为何询问"）
- resume 决策增加 `{ type: "always" }`（写入 thread ruleset）与现有
  `approveForSession` 对接（后者改为真服务端实现）

**验证**：单测式脚本验证 evaluate/wildcard（`node --test` 或临时脚本，
仓库无 test runner）；四模式冒烟 + thread 级 always 放行跨审批点生效。

---

## 阶段 3：消息级 Agent + plan→build 自动切换

**目标**：agent 绑定到消息而非 thread，plan 批准后自动切回 build agent
（对齐 opencode 的消息级切换）。

| 项 | 改动 |
|---|---|
| `server/db/schema.ts` | messages 表增加 `agent` 列（nullable，迁移脚本：回填 thread.access_mode） |
| chat `/agent` 端点 | 每条 user 消息记录 agent；未指定时继承 `lastUser.agent`（对齐 opencode prompt.ts:437） |
| thread.accessMode | 退化为"当前 agent"缓存（UI 恢复会话用），权威在消息级 |
| `submit_plan` 批准路径 | 删除"切 confirm"；改为注入 synthetic user 消息（agent: "build"，内容"计划已批准，开始执行"），graph 按 build agent 重建 |
| 模式 PATCH 端点 | 语义变为"设置下一条消息的 agent" |
| 前端 | useChat 维护 currentAgent；AskPanel plan_approval 文案改"批准并切换到 build 执行" |

**注意点**：`submit_plan` 工具需在 build preset 中保留（阶段 1 已如此），
synthetic 消息机制需在 `streamResume` 内支持"追加 user 消息再续跑"
（opencode 是新 prompt，我们可复用 resume 后紧跟新输入或双流拼接，
实现时定夺）。

---

## 阶段 4：收尾与清理

- `config.ts` 删除 `AccessMode` 类型别名、`interruptOnForMode`
  （被 permission 引擎取代）
- `DESTRUCTIVE_TOOLS`、`_addInterruptOn` 中被规则取代的部分清理
- `AGENTS.md` / `ARCHITECTURE_PLAN.md` 更新架构说明
- TUI 包（若在用）同步 agent 选择概念

---

## 顺序与工作量评估

| 阶段 | 规模 | 风险 | 依赖 |
|---|---|---|---|
| 1 preset 重构 | ~8 文件，中小 | 低（纯重构，行为不变） | 无 |
| 2 permission 引擎 | ~10 文件，中大 | 中（FileEditGuard 语义对齐、glob 边界） | 阶段 1 |
| 3 消息级 agent | ~6 文件，中 | 中（synthetic 消息、DB 迁移） | 阶段 2 |
| 4 清理 | 小 | 低 | 1-3 |

**建议从阶段 1 开始单独提交**，每阶段一个 PR 粒度。

---

## 实施记录（2026-08-18）

### 阶段 1 ✅ — 内置 Agent Preset

- 新增 `packages/core/src/agents/builtin.ts`：`AgentPreset` 接口 + 四个
  内置 preset（plan/confirm/auto/full），包含 `promptBlock` /
  `disabledTools` / `interruptOnOverride` / `bypassFileEditGuard` /
  `submitPlan` / `permissionConfig`。
- `makeGraph` 新增 `agent?: string` 参数（`accessMode` 保留为兼容别名）；
  graph 缓存键、工具剥离、FileEditGuard、submit_plan 注入全部由 preset
  驱动。
- `DynamicContextMiddleware` 删除 AccessMode switch，改收
  `agentName` + `promptBlock`。
- server：`/api/chat/agent` 接受 `agent` 字段（`mode` 兼容）；PATCH 新增
  `/thread/:id/agent`（`/mode` 保留为别名）。
- tentacle：`ChatRequest.agent` + `setThreadAgent()`（`setThreadMode` 别名）。
- web：`useChat` 发送 `agent`、持久化走 `setThreadAgent`。
- 用户自定义 primary 智能体未在本阶段实施（BUILTIN_AGENTS 扩展点已就绪）。

### 阶段 2 ✅ — Permission Ruleset 引擎

- 新增 `packages/core/src/permission/`（types / wildcard / index）：
  - `evaluate`：findLast 规则求值，未匹配默认 `ask`。
  - `wildcardMatch`：`*`/`**`/`?` glob，win32 大小写不敏感，路径归一化。
  - `rulesetFromConfig`：`{edit: {"*": "deny", "docs/**.md": "allow"}}`
    扁平化为规则数组。
  - `staticallyDisabledTools`：deny + pattern `*` → 工具静态移除。
- 每个 preset 增加 `permissionConfig`（声明式）+ `permission`（编译结果），
  `interruptOnOverride` 在模块初始化时由规则派生（
  `interruptOnForRuleset(permission, GATED_TOOLS)`），四个 preset 派生
  结果与阶段 1 字面量逐一验证一致。
- **always 写回**：threads 表新增 `permission` 列（JSON Ruleset，
  idempotent ALTER TABLE）；`addThreadPermissionRule` /
  `getThreadPermissionRules`；resume 端点把 `always` 决策持久化为
  thread 级 allow 规则并折叠为 `approve` 传给 langchain；/agent 与
  resume 的 interruptOn override 均合并 thread 规则（later wins）。
- **切换 agent 时清空 thread 规则**（`updateThreadAccessMode` 置
  permission=null）——always 批准属于其授权时的 agent 上下文。
- 前端 AskPanel "本会话都批准" 改发 `{type:"always", tool}`；客户端
  sessionAllowlist 自动批准 fast path 保留（UI 即时性），服务端规则为
  权威实现。
- FileEditGuard 的 ask 中间态未实施（仍为硬拦/绕过两态）——留待后续。

### 阶段 3 ✅ — 消息级 Agent + plan→build 切换

- **未加 SQL 列**：agent 存于 messages 表已有的 `extra_metadata`
  （`{agent: "plan"}`），零迁移。
- `/agent` 端点：每条 user 消息记录 agent；未指定时继承
  `lastUser.extraMetadata.agent`（opencode prompt.ts:437 语义），再回退
  thread.accessMode，最后 "confirm"。
- plan_approval 批准：切换 thread agent 到 confirm + 注入 synthetic
  user 消息（"计划已批准，开始执行…"，agent=confirm）。
- web 会话恢复：`load` 从最后一条 user 消息同步 agent 选择器。

### 阶段 4（部分）— 清理与文档

- 本文档更新；AGENTS.md 架构说明已补。
- `DESTRUCTIVE_TOOLS` / `_addInterruptOn` 清理未做（仍为 preset 数据源
  与编译期 HITL 配置，属合理保留）。

### ZCode 语义对齐修正（第三轮）

按 ZCode 四档真实语义重写了 preset 权限规则（差异：原 confirm 对所有
Bash 逐次审批，ZCode 只对非只读命令审批；原 auto 全免审 + shell 写硬拦，
ZCode accept-edits 是"编辑放行、Bash 仍审批"）：

| 命令 | plan | confirm (default) | auto (accept-edits) | full |
|---|---|---|---|---|
| 只读 Bash（rg/ls/git diff…） | 免审 | 免审 | 免审 | 免审 |
| 普通 Bash（npm test/rm…） | 免审 | 审批 | 审批 | 免审 |
| shell 写文件（sed -i/echo >…） | 硬拦 | 审批 | 审批 | 免审 |
| write_file / edit_file | 工具剥离 | 审批 | 自动放行 | 自动放行 |

实现要点：
- `READONLY_EXECUTE` 白名单（rg/grep/find/ls/cat/git 只读子命令等），
  confirm 与 auto 共用；
- **规则顺序**：findLast 求值下 catch-all 必须在前、具体例外在后
  （`{ "*": "ask", "rg *": "allow" }`）——与直觉相反，与 opencode
  配置风格一致；
- auto 的 `interruptOnOverride` 派生结果不再包含 execute（Bash 审批），
  但包含 write_file/edit_file/task（自动放行）。

### 遗留项收尾（第二轮）

- **FileEditGuard ask 中间态（遗留 1）✅**：
  - `FileEditGuardMiddleware` 接受 `fileWriteRuleset`——对检测到的
    shell 文件写命令按 `shell_file_write` 规则求值：deny 硬拦（重定向
    到 edit_file/write_file，历史行为）、ask/allow 放行至 HITL。
  - `_addInterruptOn` 给 `execute` 配置 `when` 谓词
    （`shouldInterruptExecute`）：普通命令跟随 `execute` 规则（confirm
    的 `*: ask` 保持逐次审批），文件写命令叠加 `shell_file_write`
    （confirm 中为 **ask** —— 新中间态：审批而非硬拦）。
  - preset 规则：plan=`deny`（硬拦）、confirm=`ask`（审批）、
    auto=`deny`（保持 FileEditGuard 重定向）、full 绕过。
- **interrupt payload 带匹配规则（遗留 3）✅**：`execute` 的动态
  description（langchain HITL 函数式签名）嵌入匹配规则
  （`matched permission rule "execute: *" → ask`）；AskPanel 将其渲染
  为"触发规则"chip（灰底样式，与问题文本分离）。
- 剩余遗留：用户自定义 primary 智能体（扩展点就绪）。
