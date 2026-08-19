# 模式切换机制重做：新增 "完全控制"(full) 模式 + 中途切换感知

## 背景与根因（已查清）

用户反馈"自动编辑模式下触及安全的命令仍要审核"，调查确认有 **3 个独立根因**，本方案一并解决：

1. **resume 路径丢失模式**（真 bug）：`server/src/routes/chat.ts:295-304` 的 resume 端点既不传 `accessMode` 给 `makeGraph`，也不重注入 `context.interruptOn` override。后果：auto 模式的 turn 一旦被任何 interrupt 打断（如 `ask_user_question`），resume 后续的破坏性工具调用会掉回 confirm 行为，弹出真正的 tool_approval 审核弹窗。**这是"中途切换不生效"和"auto 还弹审核"的主要代码根因。**
2. **`FileEditGuardMiddleware` 不区分模式**：`core/src/middleware/file_edit_guard.ts` 对 sed/echo>/cat>/tee 等 shell 改文件命令做硬拦截（返回 error ToolMessage），不读 accessMode。用户把它感知成"安全命令还要审核"。
3. **缺"完全控制"语义**：现有 `auto` 只抑制工具调用批准；用户想要更激进的 full 模式——连 FileEditGuard 的内容拦截也放行（agent 自负其责）。

## 设计决策（已与用户确认）

- **新增第四种模式 `full`（"完全控制"）**：工具调用全部放行 + FileEditGuard 内容拦截也放行。`ask_user_question` 主动提问**保留**（仍弹出，因为那是 agent 真要信息）。
- **生效粒度 = 下次审核点生效**：不实时改正在流的 turn，而是把模式持久化到 thread，每次 resume/新消息都读取最新模式。
- **持久化范围 = 整个会话**：切换后该 thread 的所有后续消息和 resume 都按新模式，直到再次切换。

四模式语义矩阵：

| 模式 | 破坏性工具 HITL | FileEditGuard 内容拦截 | ask_user_question 提问 |
|---|---|---|---|
| `plan` | 工具被裁剪（无） | — | 弹出 |
| `confirm` | **审核** | **拦截** | 弹出 |
| `auto` | 放行 | **拦截** | 弹出 |
| `full`(新) | 放行 | **放行** | 弹出 |

## 实施步骤

### 1. core：扩展 AccessMode 类型与 interruptOnForMode
**文件：`core/src/config.ts`**
- `AccessMode` 类型加上 `"full"`：`export type AccessMode = "plan" | "confirm" | "auto" | "full";`
- `interruptOnForMode()`：`full` 与 `auto` 返回相同的 override（都抑制所有 gated 工具）。逻辑改为 `if (mode === "auto" || mode === "full") { ... }`。
- `DESTRUCTIVE_TOOLS` 不变。

### 2. core：让 FileEditGuardMiddleware 感知模式
**文件：`core/src/middleware/file_edit_guard.ts`** + **`core/src/agent.ts`**
- FileEditGuard 需要拿到当前 run 的 accessMode。两个可选注入路径，**采用方案 B**：
  - **方案 A**：通过 `runtime.context` 传（类似 interruptOn），中间件读 `config.context.accessMode`。需确认中间件能拿到 runtime context。
  - **方案 B（采用）**：在 `agent.ts:_makeGraphUncached` 组装 middleware 时，把 `options.accessMode` 作为构造参数传给 `FileEditGuardMiddleware`（如 `new FileEditGuardMiddleware({ skipInFullMode: accessMode === "full" })`）。因为 accessMode 已是图缓存键的一部分，full 模式会编译独立图，缓存安全。
- FileEditGuard 内部：若 `skipInFullMode === true`，wrapToolCall 直接放行（不拦截、不返回 error），让 agent 自负其责。

### 3. core：agent.ts 工具裁剪逻辑确认
**文件：`core/src/agent.ts:483-497`**
- 现有 plan 裁剪逻辑保持。`full`/`auto`/`confirm` 都保留全部工具。
- 确认图缓存键 `modeSignature`（`agent.ts:396`）已包含 accessMode，4 种模式各编译一张图。

### 4. server：修复 resume 路径丢模式 + 持久化 mode 到 thread
**文件：`server/src/routes/chat.ts`** + **数据层 `getThread`/`updateThread`**

#### 4a. 持久化 accessMode 到 thread 记录
- 在 thread 数据结构中加 `accessMode` 字段（内存 + JSON 持久化）。
- `POST /agent`（`chat.ts:206`）：首次发消息时把 `accessMode` 存入 thread（`updateThread(threadId, { accessMode })`）。
- 新增轻量端点 `PATCH /api/chat/thread/:id/mode`（或在现有 thread update 端点上扩展），让前端切换模式时即时写回 thread，**无需发新消息**。这样"下次审核点生效"成立——切换后立即持久化，resume 时读到新值。

#### 4b. resume 端点读取 thread 的 accessMode
**文件：`chat.ts:295-304`**
- 改为：`const accessMode = existingThread?.accessMode ?? "confirm";`
- `makeGraph(config, { ..., accessMode })`（影响工具裁剪 + FileEditGuard 行为）。
- 重注入 override：`const interruptOverride = interruptOnForMode(accessMode);` → `langgraphConfig = { configurable: {...}, ...(interruptOverride ? { context: { interruptOn: interruptOverride } } : {}) }`。
- 这同时修了原 bug（resume 掉回 confirm）。

### 5. tentacle：类型同步
**文件：`tentacle/src/types.ts:69`**
- `ChatRequest.mode?: "plan" | "confirm" | "auto" | "full";`
- 新增 `setThreadMode(threadId, mode)` 客户端方法（调 `PATCH /api/chat/thread/:id/mode`）。

### 6. web：前端 UI 与状态
**文件：`web/src/components/chat/constants.tsx` + `web/src/hooks/useChat.ts` + `InputBar.tsx`**
- `AccessMode` 类型加 `"full"`；`ACCESS_MODES` 加 full 条目（icon 用 `UnlockOutlined` 或 `CrownOutlined`，label "完全控制"，hint "全自动，含安全命令"，dangerous: true）。
- `MODE_ORDER` 加 full：`["plan","confirm","auto","full"]`（Shift+Tab 循环更新）。
- 模式切换副作用：在 `setAccessMode` 的同时调 `sdk.setThreadMode(activeThreadId, newMode)` 写回服务端（实现"切换即持久化"）。注意：当前 useChat 用 useState 管 accessMode——改为切换时也触发服务端写入。
- 默认模式仍 `"confirm"`。
- full 模式风险横幅：在 InputBar 的 auto 横幅旁加 full 横幅（"完全控制：连安全命令也将自动执行，请谨慎"）。

### 7. web：useChat 中"下次审核点生效"的前端感知（可选增强）
- 由于 resume 端点现在读 thread.accessMode，前端无需特殊处理即可"下次审核点生效"。
- 可选：AskPanel 上显示"当前会话模式: X"，让用户知道点批准/拒绝后会按哪个模式继续（提升可感知性）。

## 验证方式
- 每个包跑 `tsc --noEmit`（项目无 test runner，按 AGENTS.md 用 lint/typecheck 验证）。
- 手动场景：
  1. confirm 模式发消息触发工具审核 → 切到 full → resume → 后续工具不再弹审核。
  2. full 模式下发 sed 改文件命令 → 不再被 FileEditGuard 拦截。
  3. auto 模式 turn 被 ask_user_question 打断 → resume → 后续 execute 不再误弹审核（修复回归）。

## 不做的事（范围控制）
- 不动全局设置页的 interactive/autoApprove 开关（那是另一套未接线的机制，留待后续）。
- 不改 `ask_user_question` 工具——full 模式下提问仍正常弹出（按用户确认）。
- 不做"切换即重跑/中断当前流"——按用户选择"下次审核点生效"。