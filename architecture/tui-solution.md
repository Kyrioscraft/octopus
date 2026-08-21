# TUI 方案设计

> **状态：已实施（`packages/tui`）。** 本文保留设计思想与渲染机制，
> 作为 TUI 演进的参考；完整实现见 `packages/tui/src`。
> 技术栈：Ink（React 终端渲染）+ Oclif（命令框架）。
> 核心目标：**流式 AI 聊天体验丝滑不闪烁**。

---

## 1. 核心设计思想：Block 粒度拆分 + Static 冻结

Agent 的真实输出是**多阶段的复杂序列**：思考（spinner）→ 流式文本 →
工具调用（pending → running → done）→ 确认（等待 y/n）→ 更多文本。
如果全部拼进一个组件，每次 token 到达都整段重绘，终端剧烈闪烁。

把输出拆成 **Block**——回合内的最小渲染单元，每个 Block 有独立生命周期：

- **完成后立刻推入 `<Static>`**，永久冻结在终端上方，不再参与 React diff；
- **进行中的**留在动态区，只占最少行数参与每帧重绘。

**效果：每帧最多 1 个 Block 在重绘，O(1) diff，零闪烁，历史无限增长
不影响实时性能。**

## 2. AgentBlock 数据模型

（完整定义见 `packages/tui/src`，此处为概念模型）

```ts
type BlockStatus =
  | 'pending' | 'running' | 'streaming'
  | 'done' | 'approved' | 'rejected';

type AgentBlock =
  | { type: 'thinking'; status: 'running' | 'done'; content?: string }
  | { type: 'text'; status: 'streaming' | 'done'; content: string }
  | { type: 'tool_call'; status: 'pending' | 'running' | 'done';
      tool: string; input: Record<string, unknown>;
      output?: string; error?: string }
  | { type: 'confirm'; status: 'pending' | 'approved' | 'rejected';
      message: string; action?: string; result?: string };

/** 一个回合 = user 消息 + assistant 回复（多个 Block） */
interface Turn { id: string; role: 'user' | 'assistant'; blocks: AgentBlock[]; finished: boolean; }
```

生命周期状态机：

```
pending → running / streaming → done ──────────→ 推入 <Static> 冻结
confirm: pending → approved / rejected ─────────→ 推入 <Static> 冻结
```

"完成"（frozen）判定：非 confirm 的 `status === 'done'`；confirm 的
`approved / rejected`。

## 3. Block 流与渲染的解耦

Agent 内核**不关心渲染**，只产出 Block 流（回调接口：
`onThinkingStart/End`、`onTextStart/Delta/End`、`onToolStart/End`、
`onConfirm`（返回 Promise 等待用户）、`onTurnStart/End`）。CLI/TUI 用
自己的渲染器消费；hook 层把回调映射为对 `SessionState` 的
add/update Block 操作。

## 4. 不闪烁的渲染机制

渲染器把 session 拆成两个数组：

- **frozen**：已 finished 的 turn 整体冻结；进行中 turn 里状态为
  frozen 的 Block 立刻冻结 → `<Static items={frozen}>`；
- **active**：进行中的 Block → 普通 JSX，实时更新（最多 1 个）。

`<Static>` 的语义：items 数组内容（对象引用）没变时，React 连 render
都不走，终端不发送任何重绘指令到该区域；新增项只追加输出。因此即使
每帧重建 `frozen` 数组，只要 Block 引用不变就零成本。

时间线（每帧动态区至多 1 行）：

```
You: 重构 app.ts                        ← Static
🤔 Thinking complete                    ← Static（思考结束即冻结）
📝 我来分析 app.ts 的逻辑...             ← Static（文本流结束即冻结）
🔧 read_file("app.ts") [✓ done]         ← Static
📝 基于代码分析，我建议...│              ← Dynamic（正在流式，唯一重绘行）
> _                                     ← 输入框
```

## 5. Block 渲染组件

按 type 分发到 `ThinkingBlock / TextBlock / ToolCallBlock /
ConfirmBlock`：

- **thinking**：running 时 Spinner + 尾部 60 字符预览；done 后仅显示
  完成标记 + 字符数（冻结前最后一帧）。
- **text**：内容 + streaming 时的光标符。
- **tool_call**：running 时 Spinner + 工具名 + 参数摘要；done 后显示
  ✓/✗、截断后的 output（前 ~500 字符 / 10 行）或 error。
- **confirm**：`useInput` 捕获 y/n；pending 时显示提示与按键说明，
  resolved 后显示批准/拒绝结果并冻结。全局同时最多一个 pendingConfirm，
  此时输入框被确认组件替换。

## 6. 用户输入

自绘输入框（`useInput` 处理可打印字符 / backspace / Enter 提交），
Agent 运行时禁用；确认交互时整个 TUI 暂停等待 y/n。

## 7. 性能优化

| 优化项 | 做法 | 影响 |
|---|---|---|
| rAF 节流 | token 先入 buffer，每帧 flush 一次到 state | 从 100fps setState 降到 ≤60fps，消除抖动 |
| `<Static>` 冻结 | 完成 Block 立刻推入 Static | 历史内容零 diff，O(1) 渲染 |
| 工具输出截断 | 大文本只显示前 ~500 字符 / 10 行 | 避免终端缓冲区溢出 |
| 键盘事件过滤 | 忽略非可打印键 | 减少无意义 state 更新 |

## 附：关键概念速查

| 概念 | 含义 |
|---|---|
| Block | Agent 输出的最小渲染单元（`AgentBlock`） |
| Turn | 一次用户消息 → AI 回复的完整回合 |
| Frozen | 已完成、推入 `<Static>`、不再重绘 |
| Active | 进行中、参与每帧 diff |
| rAF 节流 | token 缓冲 + 每帧一次 flush |
| 确认挂起 | TUI 暂停等待用户 y/n（`pendingConfirm`） |
