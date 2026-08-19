
# TUI 改造方案：基于 tui-solution.md 的 Block 架构重构

## 概述

将 TUI 从当前的**消息级渲染**（`ChatMessageData` 扁平列表）改造为**Block 级渲染**（`Turn → AgentBlock[]` 模型），实现：
- ✅ 完成即冻结：已完成的 Block 立即推入 `<Static>`，历史内容不参与 React diff
- ✅ 零闪烁流式输出：动态区每帧最多 1 个 Block 在重绘，O(1) diff
- ✅ rAF 节流：token 缓冲 + requestAnimationFrame，消除高频 setState 导致的抖动
- ✅ 确认交互内联化：ConfirmBlock 直接嵌入对话流，替代独立的 ApprovalMenu

改造**仅限 tui 包**，不修改 core/server/tentacle/web。保持与 server NDJSON 协议的兼容。

---

## Phase 1：类型定义 —— 引入 AgentBlock 数据模型

### 文件：`tui/src/types.ts`（追加，不改现有类型）

新增类型：

```typescript
// Block 唯一标识
type BlockId = string;

// Block 状态枚举
type BlockStatus = 'pending' | 'running' | 'streaming' | 'done' | 'approved' | 'rejected';

// Block 联合类型
type AgentBlock =
  | { id: BlockId; type: 'thinking'; status: 'running' | 'done'; content?: string }
  | { id: BlockId; type: 'text'; status: 'streaming' | 'done'; content: string }
  | { id: BlockId; type: 'tool_call'; status: 'pending' | 'running' | 'done'; tool: string; input: Record<string,unknown>; output?: string; error?: string }
  | { id: BlockId; type: 'confirm'; status: 'pending' | 'approved' | 'rejected'; message: string; action?: string; result?: string };

// 对话回合
interface Turn {
  id: string;
  role: 'user' | 'assistant';
  blocks: AgentBlock[];
  finished: boolean;
}

// 全局会话状态
interface SessionState {
  turns: Turn[];
  pendingConfirm: BlockId | null;
}

// Block 流回调接口
interface BlockStreamCallbacks {
  onThinkingStart: (id: BlockId) => void;
  onThinkingEnd: (id: BlockId, content?: string) => void;
  onTextStart: (id: BlockId) => void;
  onTextDelta: (id: BlockId, token: string) => void;
  onTextEnd: (id: BlockId) => void;
  onToolStart: (id: BlockId, tool: string, input: Record<string,unknown>) => void;
  onToolEnd: (id: BlockId, output: string, error?: string) => void;
  onConfirm: (id: BlockId, message: string, action?: string) => Promise<boolean>;
  onTurnStart: () => void;
  onTurnEnd: () => void;
}
```

保留所有现有类型（`ChatMessageData`、`ToolCallData` 等）用于：
- 线程历史持久化（server 存储的是 message，不是 block）
- 向后兼容

---

## Phase 2：Block 渲染组件

### 新建目录：`tui/src/components/blocks/`

| 文件 | 组件 | 说明 |
|------|------|------|
| `thinking.tsx` | `ThinkingBlock` | spinner + 思考文本（running）/ 完成标记（done） |
| `text.tsx` | `TextBlock` | 流式文本 + 光标闪烁（streaming）/ 完整文本（done） |
| `tool-call.tsx` | `ToolCallBlock` | 工具名+参数+spinner（running）/ 结果+输出截断（done） |
| `confirm.tsx` | `ConfirmBlock` | y/n 提示（pending）/ 已批准/已拒绝（approved/rejected） |
| `index.tsx` | `BlockView` | switch(block.type) 分发到对应组件 |

每个组件遵循 `<Static>` 兼容原则：
- 组件不关心自己是在 Static 还是 Dynamic 区域
- 已完成状态的渲染输出是"最终态"，与首次渲染一致
- ConfirmBlock 接收 `onAnswer` callback，通过 `useInput` 捕获 y/n

### 输出截断（ToolCallBlock）

```typescript
const MAX_TOOL_OUTPUT = 500;  // 最多 500 字符
const MAX_TOOL_LINES = 10;    // 最多 10 行
```

---

## Phase 3：性能优化 —— useTextBuffer hook

### 新建文件：`tui/src/hooks/use-text-buffer.ts`

实现 rAF 节流的 token 缓冲器：

```typescript
function useTextBuffer(onFlush: (updates: Map<BlockId, string>) => void) {
  // buffer: Map<BlockId, string[]>
  // push(id, token) → 写入 buffer → 注册 rAF
  // flush() → 合并 tokens → 调用 onFlush → 清空 buffer
  // useEffect cleanup → cancelAnimationFrame
}
```

效果：每秒最多 60 次重绘，每次 flush 所有待处理 token。

---

## Phase 4：Block 流适配器 —— stream events → blocks

### 新建文件：`tui/src/core/block-stream.ts`

在现有 `tui-adapter.ts` / `stream-events.ts` **之外**创建 Block 级适配器：

```typescript
function mapStreamToBlocks(
  stream: AsyncGenerator<StreamEvent>,
  callbacks: BlockStreamCallbacks,
  signal?: AbortSignal,
): Promise<void>
```

核心映射逻辑：
| StreamEvent.status | 产生的 Block 回调 |
|---|---|
| `init` | 记录 thread_id → 后续使用 |
| `loading` + token（主 agent） | `onTextStart`（首次）→ `onTextDelta`（追加） |
| `loading` + tool_calls | `onToolStart`（每个 tool）→ `onToolEnd`（结果到达） |
| `reasoning` | `onThinkingStart`（首次）→ 累积 content |
| `ask_user_question_required` | `onConfirm`（返回 Promise，等待用户 y/n） |
| `finished` | `onThinkingEnd` → `onTextEnd` → `onTurnEnd` |
| `interrupted` | `onTextEnd` → 等待 resume |
| `error` | 记录 error block |

**与现有代码的关系**：`block-stream.ts` 是新文件，不修改 `tui-adapter.ts`。`use-chat-session.ts` 新增一个 `executeMessageAsBlocks()` 方法，内部调用 `mapStreamToBlocks`。

---

## Phase 5：Block 级 ChatRenderer —— 增强 MessageList

### 修改文件：`tui/src/components/messages.tsx`

在现有 `MessageList` 基础上增强（或新增 `ChatRenderer` 组件作为替代）：

```typescript
function ChatRenderer({ session }: { session: SessionState }) {
  // 1. 遍历 turns → 分离 frozen（已完成）和 active（进行中）
  // 2. frozen → <Static items={frozen}>{block => <BlockView block={block} />}</Static>
  // 3. active → <Box>{active.map(block => <BlockView key={block.id} block={block} />)}</Box>
}
```

冻结判断逻辑（与文档一致）：
```typescript
function isBlockFrozen(block: AgentBlock): boolean {
  if (block.type === 'confirm') return block.status === 'approved' || block.status === 'rejected';
  return block.status === 'done';
}
```

- 整个 Turn 完成 → 所有 blocks 冻结
- 进行中的 Turn → 已完成的 blocks 冻结，进行中的留在动态区
- 保留 generation key 机制（消息数量骤降时强制刷新 Static）

### 保留现有 `MessageList`
旧的消息级渲染作为 fallback，用于从服务器加载历史线程（history → ChatMessageData[] → MessageList），同时新的实时代理会话使用 Block 渲染。两者可以共存于同一个界面（通过 `useBlockRendering` flag 切换）。

---

## Phase 6：useAgent hook —— Block 级状态管理

### 新建文件：`tui/src/hooks/use-agent.ts`

```typescript
function useAgent() {
  const [session, setSession] = useState<SessionState>({ turns: [], pendingConfirm: null });
  
  // 内部集成 useTextBuffer
  const textBuffer = useTextBuffer((updates) => { /* batch update text blocks */ });
  
  // 构建 BlockStreamCallbacks
  const callbacks: BlockStreamCallbacks = {
    onThinkingStart: (id) => addBlock({ id, type: 'thinking', status: 'running' }),
    onThinkingEnd: (id, content) => updateBlock(id, { status: 'done', content }),
    onTextStart: (id) => addBlock({ id, type: 'text', status: 'streaming', content: '' }),
    onTextDelta: (id, token) => textBuffer.push(id, token),
    onTextEnd: (id) => updateBlock(id, { status: 'done' }),
    onToolStart: (id, tool, input) => addBlock({ id, type: 'tool_call', status: 'running', tool, input }),
    onToolEnd: (id, output, error) => updateBlock(id, { status: 'done', output, error }),
    onConfirm: async (id, message, action) => {
      addBlock({ id, type: 'confirm', status: 'pending', message, action });
      return new Promise(resolve => { pendingResolve = resolve; });
    },
    onTurnStart: () => { /* 创建新 assistant turn */ },
    onTurnEnd: () => { /* 标记 turn finished */ },
  };
  
  return { session, callbacks, isRunning };
}
```

### 修改文件：`tui/src/hooks/use-chat-session.ts`

在现有 `useChatSession` 中新增：
- `sessionState: SessionState` — block 级会话状态（与现有 `messages: ChatMessageData[]` 并存）
- `executeMessageAsBlocks(text)` — 使用 `mapStreamToBlocks` 的新执行路径
- 原有 `executeMessage` 保持不变，确保向后兼容

---

## Phase 7：主屏幕集成

### 修改文件：`tui/src/components/screens/main-screen.tsx`

```tsx
// 主要改动：
// 1. 接收新的 session prop
// 2. 使用 <ChatRenderer session={session}> 替代 <MessageList messages={messages}>
// 3. ConfirmBlock 直接在对话流中内联渲染（不再使用独立的 ApprovalMenu）
// 4. 输入框在 Agent 运行时隐藏（与文档一致）
```

### 修改文件：`tui/src/app.tsx`

```tsx
// 新增：
// - 从 useChatSession 中获取 sessionState
// - 传递给 MainScreen
// 
// 不改动现有 props 传递结构
```

---

## 文件变更清单

### 新建文件（7 个）
| 文件 | 说明 |
|------|------|
| `tui/src/components/blocks/index.tsx` | BlockView 分发器 |
| `tui/src/components/blocks/thinking.tsx` | Thinking 块渲染 |
| `tui/src/components/blocks/text.tsx` | 流式文本块渲染 |
| `tui/src/components/blocks/tool-call.tsx` | 工具调用块渲染 |
| `tui/src/components/blocks/confirm.tsx` | 确认块渲染（含 useInput y/n） |
| `tui/src/hooks/use-text-buffer.ts` | rAF 节流 token 缓冲器 |
| `tui/src/core/block-stream.ts` | StreamEvent → BlockStreamCallbacks 映射 |

### 修改文件（4 个）
| 文件 | 改动范围 |
|------|----------|
| `tui/src/types.ts` | **追加** AgentBlock、Turn、SessionState、BlockStreamCallbacks 类型 |
| `tui/src/components/messages.tsx` | **追加** ChatRenderer 组件（Block 级 Static/Dynamic 渲染） |
| `tui/src/hooks/use-chat-session.ts` | **追加** sessionState、executeMessageAsBlocks、BlockStreamCallbacks 构建 |
| `tui/src/components/screens/main-screen.tsx` | **适配** 接收 session prop，使用 ChatRenderer |

### 不改动文件
- `tui/src/cli.ts` — CLI 入口不变（Commander 保留）
- `tui/src/app.tsx` — 整体结构保持，仅新增 session prop 透传
- `tui/src/client/` — server 通信层不变
- `tui/src/core/tui-adapter.ts` — 保留，旧路径继续工作
- `tui/src/core/stream-events.ts` — 保留
- `tui/src/core/tool-tracker.ts` — 保留
- `tui/src/hooks/use-server-connection.ts` — 不变
- `tui/src/hooks/use-modal-manager.ts` — 不变
- `tui/src/hooks/use-command-registry.ts` — 不变
- `tui/src/components/chat-input.tsx` — 当前实现已满足方案需求
- `tui/src/components/modals/` — 不变
- `tui/src/components/screens/connecting-screen.tsx` — 不变
- `tui/src/components/screens/error-screen.tsx` — 不变
- 所有 `terminal/`、`input/`、`utils/`、`commands/` 文件 — 不变

---

## 验证标准

1. `cd tui && npm run lint`（tsc --noEmit）通过，零类型错误
2. 现有 Import 路径不受影响（新类型和组件在独立文件中）
3. 消息级渲染（旧路径）和 Block 级渲染（新路径）可共存，通过 flag 切换

---

## 不做的事

- ❌ 不替换 Commander 为 Oclif（方案中的 CLI 框架选择不关键，Commander 工作良好）
- ❌ 不修改 core/server/tentacle/web 包
- ❌ 不删除现有 message-views（保留作为 fallback）
- ❌ 不改变 server 通信协议（NDJSON 不变）
- ❌ 不重写整个 useChatSession（增量追加，不破坏现有流程）
