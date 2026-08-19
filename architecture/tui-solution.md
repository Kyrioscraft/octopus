# TUI 方案设计文档

> 基于 Ink（React 写终端界面）+ Oclif（命令框架）的 AI Agent 终端交互方案。
> 核心目标：**流式 AI 聊天体验丝滑不闪烁**，支持思考过程、工具调用、用户确认等复杂交互。

---

## 目录

- [1. 核心设计思想](#1-核心设计思想)
- [2. AgentBlock 数据模型](#2-agentblock-数据模型)
- [3. Block 流与回调接口](#3-block-流与回调接口)
- [4. 不闪烁的渲染机制](#4-不闪烁的渲染机制)
- [5. Block 渲染组件](#5-block-渲染组件)
- [6. 用户输入](#6-用户输入)
- [7. 性能优化](#7-性能优化)
- [8. 完整示例代码](#8-完整示例代码)

---

## 1. 核心设计思想

### 1.1 问题

一个 AI Agent 的真实输出不是"一段纯文本"，而是一个**多阶段的复杂序列**：

```
🤔 正在思考...              ← thinking block（spinner，可能持续数秒）
📝 我来分析这个函数的逻辑...   ← text block（流式，token 逐个到达）
🔧 调用工具: read_file       ← tool_call block（pending → running → done）
📋 工具返回 300 行代码        ← tool_call 结果展示
📝 基于代码分析，我建议...     ← 又一个 text block（流式）
⚠️ 确认执行: rm -rf /dist   ← confirm block（暂停，等待用户输入 y/n）
📋 执行结果: 成功             ← 结果展示
📝 重构完成！                 ← 最后一段 text block
```

如果简单地把所有内容拼成一个 `<Text>` 组件，每次 token 到达都整段重绘，**终端会剧烈闪烁**。

### 1.2 解决方案：Block 粒度拆分 + Static 冻结

把 Agent 输出拆成 **Block**——回合内的最小渲染单元。每个 Block 有独立生命周期：

- **完成后立刻被推入 `<Static>`**，永久冻结在终端上方，不再参与 React diff
- **进行中的**继续留在动态区，只占用最少行数参与每帧重绘

**效果：每帧最多 1 个 Block 在重绘，其余全部已冻结。O(1) diff，零闪烁。**

---

## 2. AgentBlock 数据模型

### 2.1 完整类型定义

```typescript
// ============================================================
// packages/core/src/blocks/types.ts
// ============================================================

/** 唯一标识 */
type BlockId = string;

/** Block 状态枚举 */
type BlockStatus =
  | 'pending'      // 即将开始（仅 tool_call / confirm 有）
  | 'running'      // 进行中（thinking / tool_call）
  | 'streaming'    // 流式输出中（text 专用）
  | 'done'         // 已完成
  | 'approved'     // 用户已批准（confirm 专用）
  | 'rejected';    // 用户已拒绝（confirm 专用）

/** Block 联合类型 */
type AgentBlock =
  // ── 思考过程 ──
  | {
      id: BlockId;
      type: 'thinking';
      status: 'running' | 'done';
      /** 思考过程的文本（可选，部分模型支持 stream 思考内容） */
      content?: string;
    }

  // ── 流式文本回复 ──
  | {
      id: BlockId;
      type: 'text';
      status: 'streaming' | 'done';
      content: string;
    }

  // ── 工具调用 ──
  | {
      id: BlockId;
      type: 'tool_call';
      status: 'pending' | 'running' | 'done';
      tool: string;                              // 工具名，如 'read_file'
      input: Record<string, unknown>;            // 工具参数
      output?: string;                           // 工具返回值（done 时有）
      error?: string;                            // 错误信息（done + 出错时有）
    }

  // ── 用户确认 ──
  | {
      id: BlockId;
      type: 'confirm';
      status: 'pending' | 'approved' | 'rejected';
      message: string;                           // 确认提示，如 "确认执行: rm -rf /dist ?"
      /** 如果是审批命令，这里存具体操作 */
      action?: string;
      /** 批准后的结果 */
      result?: string;
    };

/** 一个对话回合 = 用户消息 + AI 回复（含多个 Block） */
interface Turn {
  id: string;
  role: 'user' | 'assistant';
  blocks: AgentBlock[];
  /** 整个回合是否已结束 */
  finished: boolean;
}

/** 全局会话状态 */
interface SessionState {
  turns: Turn[];
  /** 等待用户确认的 block（全局最多一个） */
  pendingConfirm: BlockId | null;
}
```

### 2.2 Block 生命周期状态机

```
                   ┌──────────────┐
                   │   pending    │  (仅 tool_call / confirm)
                   └──┬───────────┘
                      │ 开始执行
                      ▼
    ┌──────────────┐  ┌──────────────┐
    │   running    │  │  streaming   │  (text 专用)
    └──┬───────────┘  └──┬───────────┘
       │ 完成             │ 流结束
       ▼                  ▼
    ┌──────────────────────────────┐
    │           done               │ ← 推入 <Static>，永久冻结
    └──────────────────────────────┘

    confirm 有额外分支：
    ┌──────────────┐
    │   pending    │ ← 等待用户输入 y/n
    └──┬──────┬────┘
   y键  │      │  n键
        ▼      ▼
    approved  rejected  ← 然后也推入 <Static>
```

### 2.3 Block 的 "完成" 判定

```typescript
function isBlockFrozen(block: AgentBlock): boolean {
  switch (block.type) {
    case 'thinking':
      return block.status === 'done';
    case 'text':
      return block.status === 'done';
    case 'tool_call':
      return block.status === 'done';
    case 'confirm':
      return block.status === 'approved' || block.status === 'rejected';
  }
}
```

---

## 3. Block 流与回调接口

### 3.1 Agent 内核的产出接口

Agent 内核（`packages/core`）**不关心渲染**，它只产出一个 Block 流。CLI 和 GUI 各自用自己的渲染器消费。

```typescript
// ============================================================
// packages/core/src/blocks/stream.ts
// ============================================================

interface BlockStreamCallbacks {
  // ── thinking ──
  onThinkingStart: (id: BlockId) => void;
  onThinkingEnd:   (id: BlockId, content?: string) => void;

  // ── text ──
  onTextStart:     (id: BlockId) => void;
  onTextDelta:     (id: BlockId, token: string) => void;
  onTextEnd:       (id: BlockId) => void;

  // ── tool_call ──
  onToolStart:     (id: BlockId, tool: string, input: Record<string, unknown>) => void;
  onToolEnd:       (id: BlockId, output: string, error?: string) => void;

  // ── confirm ──
  onConfirm:       (id: BlockId, message: string, action?: string) => Promise<boolean>;

  // ── turn ──
  onTurnStart:     () => void;
  onTurnEnd:       () => void;
}
```

### 3.2 TUI 层如何消费这个流

```typescript
// ============================================================
// packages/cli/src/tui/hooks/useAgent.ts
// ============================================================

import { useState, useCallback, useRef } from 'react';
import type { SessionState, BlockId, AgentBlock } from '@my-ai-coder/core/blocks';

export function useAgent() {
  const [session, setSession] = useState<SessionState>({ turns: [], pendingConfirm: null });

  // ===== helpers =====
  const addBlock = useCallback((block: AgentBlock) => {
    setSession(prev => {
      const turns = [...prev.turns];
      if (turns.length === 0) return prev;
      const lastTurn = { ...turns[turns.length - 1], blocks: [...turns[turns.length - 1].blocks, block] };
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  }, []);

  const updateBlock = useCallback((id: BlockId, patch: Partial<AgentBlock>) => {
    setSession(prev => {
      const turns = [...prev.turns];
      const lastTurn = { ...turns[turns.length - 1], blocks: turns[turns.length - 1].blocks.map(b =>
        b.id === id ? { ...b, ...patch } as AgentBlock : b
      )};
      turns[turns.length - 1] = lastTurn;
      return { ...prev, turns };
    });
  }, []);

  // ===== callbacks: 对接 Agent 内核的 BlockStreamCallbacks =====
  const callbacks: BlockStreamCallbacks = {
    onThinkingStart: (id) => addBlock({ id, type: 'thinking', status: 'running' }),
    onThinkingEnd:   (id, content) => updateBlock(id, { status: 'done', content }),

    onTextStart:     (id) => addBlock({ id, type: 'text', status: 'streaming', content: '' }),
    onTextDelta:     (id, token) => {
      // 不直接 setState，走缓冲节流（见第 7 章）
      textBuffer.push(id, token);
    },
    onTextEnd:       (id) => updateBlock(id, { status: 'done' }),

    onToolStart:     (id, tool, input) => addBlock({ id, type: 'tool_call', status: 'running', tool, input }),
    onToolEnd:       (id, output, error) => updateBlock(id, { status: 'done', output, error }),

    onConfirm:       async (id, message, action) => {
      addBlock({ id, type: 'confirm', status: 'pending', message, action });
      // 返回 Promise，等待用户输入
      return new Promise(resolve => { pendingResolve = resolve; });
    },

    onTurnStart: () => {
      setSession(prev => ({
        ...prev,
        turns: [...prev.turns, { id: nanoid(), role: 'assistant', blocks: [], finished: false }],
      }));
    },
    onTurnEnd: () => {
      setSession(prev => {
        const turns = [...prev.turns];
        turns[turns.length - 1] = { ...turns[turns.length - 1], finished: true };
        return { ...prev, turns };
      });
    },
  };

  return { session, callbacks, confirmBlock: /* ... */ };
}
```

---

## 4. 不闪烁的渲染机制

### 4.1 核心逻辑：Static / Dynamic 切分

```typescript
// ============================================================
// packages/cli/src/tui/renderer.tsx
// ============================================================

import { Static, Text } from 'ink';
import type { SessionState, AgentBlock, Turn } from '@my-ai-coder/core/blocks';
import { BlockView } from './blocks';

/** 判断 block 是否已完成（应冻结） */
function isBlockFrozen(block: AgentBlock): boolean {
  if (block.type === 'confirm') {
    return block.status === 'approved' || block.status === 'rejected';
  }
  return block.status === 'done';
}

/**
 * 核心渲染逻辑：
 * - frozen 数组 → `<Static items={frozen}>` 永久冻结，不参与 diff
 * - active 数组 → 普通 JSX 元素，实时更新
 */
export function ChatRenderer({ session }: { session: SessionState }) {
  const frozen: AgentBlock[] = [];
  const active: AgentBlock[] = [];

  for (const turn of session.turns) {
    if (turn.finished) {
      // 整个回合结束 → 全部冻结
      frozen.push(...turn.blocks);
    } else {
      // 进行中的回合 → 按 block 状态拆分
      for (const block of turn.blocks) {
        if (isBlockFrozen(block)) {
          frozen.push(block);   // ← 已完成的立刻冻结
        } else {
          active.push(block);    // ← 进行中的实时渲染
        }
      }
    }
  }

  return (
    <>
      {/* 冻结区：永远不动 */}
      <Static items={frozen}>
        {(block) => <BlockView key={block.id} block={block} />}
      </Static>

      {/* 动态区：只有最多 1 个 block 在重绘 */}
      {active.map(block => (
        <BlockView key={block.id} block={block} />
      ))}
    </>
  );
}
```

### 4.2 为什么 `<Static>` 能消除闪烁

Ink 的 `<Static>` 在渲染时做两件事：

1. **首次渲染**：把 `items` 里每个元素渲染成 ANSI 文本，输出到终端
2. **后续渲染**：只要 `items` 数组没变（引用没变），**React 的 render 函数连走都不走这部分**，终端也不发送任何光标移动或重绘指令到此区域

```typescript
// Ink 源码简化逻辑：
// <Static> 内部维护一个"上次渲染的行数"计数
// 每次 render 时：
//   if (items 没变) {
//     光标直接跳到 Static 区域下方，不碰上方内容
//   } else {
//     只重绘新增的那几行
//   }
```

`ChatRenderer` 里的 `frozen` 数组虽然每次渲染都在创建，但数组内容（block 对象引用）没变，所以 `<Static>` 识别出"这些 block 已经渲染过了"，跳过它们，只处理 `active` 区域。

### 4.3 时间线演示：每帧到底发生了什么

用一个完整的 Agent 回合来展示每次 `setState` 后的渲染行为：

```
初始: 用户刚发送 "重构 app.ts"
─────────────────────────────────────
FROZEN (Static):  ██████████████████████
  You: 重构 app.ts
  ──────────────────────────────────
ACTIVE (Dynamic):
  (空)


1. Agent 开始思考 (onThinkingStart)
─────────────────────────────────────
FROZEN (Static):  ██████████████████████  ← 未变，跳过
  You: 重构 app.ts                        ← 未变，跳过
  ──────────────────────────────────      ← 未变，跳过
ACTIVE (Dynamic):
  🤔  Thinking... ⠋                       ← 只有这 1 行在重绘


2. 思考结束 (onThinkingEnd) + 流式文本开始 (onTextStart)
─────────────────────────────────────
FROZEN (Static):  ██████████████████████
  You: 重构 app.ts                      ← 未变
  🤔  Thinking... (完成，推入 Static)     ← 新增 1 行
  ──────────────────────────────────
ACTIVE (Dynamic):
  📝 我来分析 app.ts 的逻辑...            ← 只有这 1 行，token 逐渐增多


3. 流式文本结束 + 工具调用开始 (onToolStart)
─────────────────────────────────────
FROZEN (Static):  ██████████████████████
  You: 重构 app.ts
  🤔  Thinking...
  📝 我来分析 app.ts 的逻辑。这个文件...  ← 推入 Static，冻结
  ──────────────────────────────────
ACTIVE (Dynamic):
  🔧 read_file("app.ts")     [running] ⠋  ← 只有这 1 行


4. 工具返回结果 (onToolEnd) + 新流式文本
─────────────────────────────────────
FROZEN (Static):  ██████████████████████
  ...全部已完成的 block...
  🔧 read_file("app.ts")     [done] ✓      ← 推入 Static
  📋 ── 文件内容 (300行) ──               ← 推入 Static
  ──────────────────────────────────
ACTIVE (Dynamic):
  📝 基于代码分析，我建议用 hooks 重写...   ← 只有这 1 行


5. 需要确认 (onConfirm)
─────────────────────────────────────
FROZEN (Static):  ██████████████████████
  ...全部已完成的 block...
  📝 基于代码分析，我建议用 hooks 重写...  ← 推入 Static
  ──────────────────────────────────
ACTIVE (Dynamic):
  ⚠️  确认执行: rm -rf /dist ?           ← 只有这 1 行
      [y/n]                              ← 等待用户按键


6. 用户按 y → 确认通过
─────────────────────────────────────
FROZEN (Static):  ██████████████████████
  ...全部已完成...
  ⚠️  确认执行: rm -rf /dist ? [已批准]   ← 推入 Static
  ──────────────────────────────────
ACTIVE (Dynamic):
  (回合可能继续，或者空)
```

**关键观察**：每一步动态区最多只有 1 个 Block。每帧的 diff 计算量 = O(1)。历史无限增长不影响实时性能。

---

## 5. Block 渲染组件

### 5.1 组件入口

```typescript
// ============================================================
// packages/cli/src/tui/blocks/index.tsx
// ============================================================

import type { AgentBlock } from '@my-ai-coder/core/blocks';
import { ThinkingBlock } from './thinking';
import { TextBlock } from './text';
import { ToolCallBlock } from './tool-call';
import { ConfirmBlock } from './confirm';

export function BlockView({ block }: { block: AgentBlock }) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock block={block} />;
    case 'text':
      return <TextBlock block={block} />;
    case 'tool_call':
      return <ToolCallBlock block={block} />;
    case 'confirm':
      return <ConfirmBlock block={block} />;
  }
}
```

### 5.2 ThinkingBlock（思考中）

```typescript
// ============================================================
// packages/cli/src/tui/blocks/thinking.tsx
// ============================================================

import { Box, Text, Spinner } from 'ink';

export function ThinkingBlock({ block }: { block: AgentBlock & { type: 'thinking' } }) {
  if (block.status === 'running') {
    return (
      <Box gap={1}>
        <Spinner label="Thinking" />
        {block.content ? (
          <Text dimColor>{block.content.slice(-60)}</Text>
        ) : null}
      </Box>
    );
  }

  // block.status === 'done' → 这一帧之后就会进入 <Static>
  return (
    <Box gap={1}>
      <Text color="green">🤔 Thinking complete</Text>
      {block.content ? (
        <Text dimColor>({block.content.length} chars)</Text>
      ) : null}
    </Box>
  );
}
```

### 5.3 TextBlock（流式文本）

```typescript
// ============================================================
// packages/cli/src/tui/blocks/text.tsx
// ============================================================

import { Box, Text } from 'ink';

export function TextBlock({ block }: { block: AgentBlock & { type: 'text' } }) {
  return (
    <Box flexDirection="column">
      <Text>{block.content}</Text>
      {block.status === 'streaming' && (
        <Text color="cyan">│</Text>  {/* 闪烁光标效果 */}
      )}
    </Box>
  );
}
```

### 5.4 ToolCallBlock（工具调用）

```typescript
// ============================================================
// packages/cli/src/tui/blocks/tool-call.tsx
// ============================================================

import { Box, Text, Spinner } from 'ink';

export function ToolCallBlock({ block }: { block: AgentBlock & { type: 'tool_call' } }) {
  if (block.status === 'running') {
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Spinner />
          <Text color="yellow">🔧 {block.tool}</Text>
          <Text dimColor>{formatInput(block.input)}</Text>
        </Box>
      </Box>
    );
  }

  // status === 'done'
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {block.error ? (
          <Text color="red">🔧 {block.tool} [✗ error]</Text>
        ) : (
          <Text color="green">🔧 {block.tool} [✓ done]</Text>
        )}
        <Text dimColor>{formatInput(block.input)}</Text>
      </Box>
      {block.output && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>┌─ output ─</Text>
          <Text dimColor>{truncate(block.output, 500)}</Text>
          <Text dimColor>└──────────</Text>
        </Box>
      )}
      {block.error && (
        <Box paddingLeft={2}>
          <Text color="red">{block.error}</Text>
        </Box>
      )}
    </Box>
  );
}

function formatInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).slice(0, 2);
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const lines = s.split('\n').slice(0, 10);
  return lines.join('\n') + '\n... (truncated)';
}
```

### 5.5 ConfirmBlock（用户确认）

```typescript
// ============================================================
// packages/cli/src/tui/blocks/confirm.tsx
// ============================================================

import { Box, Text } from 'ink';
import { useInput } from 'ink';

export function ConfirmBlock({
  block,
  onAnswer,
}: {
  block: AgentBlock & { type: 'confirm' };
  onAnswer: (approved: boolean) => void;
}) {
  useInput((input, key) => {
    if (block.status !== 'pending') return;

    if (input === 'y' || input === 'Y') {
      onAnswer(true);
    } else if (input === 'n' || input === 'N') {
      onAnswer(false);
    }
  });

  if (block.status === 'approved') {
    return (
      <Box>
        <Text color="green">⚠️  {block.message} [已批准 ✓]</Text>
      </Box>
    );
  }

  if (block.status === 'rejected') {
    return (
      <Box>
        <Text color="red">⚠️  {block.message} [已拒绝 ✗]</Text>
      </Box>
    );
  }

  // status === 'pending' → 等待用户输入
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow" bold>⚠️  {block.message}</Text>
      </Box>
      <Box>
        <Text color="cyan">[y] 批准  [n] 拒绝</Text>
      </Box>
    </Box>
  );
}
```

---

## 6. 用户输入

### 6.1 多行输入框

```typescript
// ============================================================
// packages/cli/src/tui/input.tsx
// ============================================================

import { useState } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';

interface ChatInputProps {
  onSubmit: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSubmit, disabled }: ChatInputProps) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      // Enter → 提交
      if (value.trim()) {
        onSubmit(value.trim());
        setValue('');
      }
    } else if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta && input.length === 1) {
      // 普通字符输入
      setValue(prev => prev + input);
    }
  });

  if (disabled) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>{'> '}</Text>
        <Text>{value}</Text>
        <Text color="cyan">│</Text>  {/* 光标 */}
      </Box>
      <Box>
        <Text dimColor>Enter 发送 | Ctrl+C 退出</Text>
      </Box>
    </Box>
  );
}
```

### 6.2 主入口组合

```typescript
// ============================================================
// packages/cli/src/tui/app.tsx
// ============================================================

import { Box } from 'ink';
import { useAgent } from './hooks/useAgent';
import { ChatRenderer } from './renderer';
import { ChatInput } from './input';

export function App() {
  const { session, callbacks, isRunning } = useAgent();

  const handleSubmit = async (message: string) => {
    // 添加用户消息到 session
    addUserTurn(session, message);
    // 启动 agent
    await runAgent(message, callbacks);
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* 渲染所有对话 */}
      <ChatRenderer session={session} />

      {/* 输入框（Agent 运行时隐藏） */}
      {!isRunning && <ChatInput onSubmit={handleSubmit} disabled={isRunning} />}

      {/* 确认交互时，输入框替换为确认组件 */}
      {session.pendingConfirm && (
        <ConfirmBlock
          block={findConfirmBlock(session)}
          onAnswer={(approved) => resolveConfirm(approved)}
        />
      )}
    </Box>
  );
}
```

---

## 7. 性能优化

### 7.1 流式文本的 requestAnimationFrame 节流

**问题**：LLM 流式回复每秒可达 50-100 token。如果每来一个 token 就 `setState` 一次，会造成 100fps 的重绘，远超终端渲染能力，且阻塞 Node 事件循环。

**解法**：缓冲 + rAF 节流，保证每帧最多重绘一次。

```typescript
// ============================================================
// packages/cli/src/tui/hooks/useTextBuffer.ts
// ============================================================

import { useRef, useEffect } from 'react';

/**
 * 流式文本缓冲器
 * - 收到的 token 先存入 buffer
 * - requestAnimationFrame 触发时，一次性 flush 到 state
 * - 保证每秒最多 60 次重绘，且每帧只更新一次
 */
export function useTextBuffer(
  onFlush: (updates: Map<BlockId, string>) => void,
) {
  const buffer = useRef<Map<BlockId, string[]>>(new Map());
  const rafId = useRef<number | null>(null);

  const push = (id: BlockId, token: string) => {
    if (!buffer.current.has(id)) {
      buffer.current.set(id, []);
    }
    buffer.current.get(id)!.push(token);

    // 已经有待处理的 rAF，不再重复注册
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(flush);
    }
  };

  const flush = () => {
    rafId.current = null;

    // 构建更新 map
    const updates = new Map<BlockId, string>();
    for (const [id, tokens] of buffer.current) {
      updates.set(id, tokens.join(''));
    }
    buffer.current.clear();

    if (updates.size > 0) {
      onFlush(updates);
    }
  };

  // 清理
  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

  return { push };
}
```

### 7.2 在 useAgent 中使用缓冲

```typescript
// useAgent 中集成 text buffer

const textBuffer = useTextBuffer((updates) => {
  setSession(prev => {
    const turns = [...prev.turns];
    const lastTurn = { ...turns[turns.length - 1], blocks: [...turns[turns.length - 1].blocks] };

    for (const [blockId, newTokens] of updates) {
      const idx = lastTurn.blocks.findIndex(b => b.id === blockId);
      if (idx !== -1) {
        const block = lastTurn.blocks[idx] as AgentBlock & { type: 'text' };
        lastTurn.blocks[idx] = { ...block, content: block.content + newTokens } as AgentBlock;
      }
    }

    turns[turns.length - 1] = lastTurn;
    return { ...prev, turns };
  });
});

// callbacks 中使用 buffer 而不是直接 setState
const callbacks: BlockStreamCallbacks = {
  // ...
  onTextDelta: (id, token) => {
    textBuffer.push(id, token);  // ← 走缓冲，不走直接 setState
  },
  // ...
};
```

### 7.3 工具输出的大文本截断

```typescript
const MAX_TOOL_OUTPUT = 500;   // 最多显示 500 字符
const MAX_TOOL_LINES  = 10;    // 最多显示 10 行

function truncateToolOutput(output: string): string {
  const lines = output.split('\n');
  if (lines.length <= MAX_TOOL_LINES && output.length <= MAX_TOOL_OUTPUT) {
    return output;
  }

  const truncated = lines.slice(0, MAX_TOOL_LINES).join('\n');
  if (truncated.length > MAX_TOOL_OUTPUT) {
    return truncated.slice(0, MAX_TOOL_OUTPUT) + '\n... (truncated)';
  }
  return truncated + `\n... (${lines.length - MAX_TOOL_LINES} more lines)`;
}
```

### 7.4 性能检查清单

| 优化项 | 做法 | 影响 |
|---|---|---|
| rAF 节流 | token 缓冲 + 每帧只 flush 一次 | 从 100fps 降到 60fps，消除抖动 |
| `<Static>` 冻结 | 已完成的 block 立刻推入 Static | 历史内容不参与 diff，O(1) 渲染 |
| 工具输出截断 | 大文本只显示前 500 字符/10 行 | 避免终端缓冲区溢出 |
| 键盘事件过滤 | `useInput` 中忽略非可打印键 | 减少无意义 state 更新 |

---

## 8. 完整示例代码

### 8.1 Oclif 命令入口

```typescript
// ============================================================
// packages/cli/src/commands/chat.ts
// ============================================================

import { Command } from '@oclif/core';
import { render } from 'ink';
import React from 'react';
import { App } from '../tui/app';

export default class Chat extends Command {
  static description = 'Start interactive chat with the AI agent';
  static examples = ['$ myagent chat', '$ myagent chat --model claude-sonnet'];

  static flags = {
    model: Flags.string({ char: 'm', description: 'Model to use', default: 'gpt-4o' }),
    workspace: Flags.string({ char: 'w', description: 'Project directory', default: process.cwd() }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Chat);

    const { unmount } = render(
      React.createElement(App, {
        model: flags.model,
        workspace: flags.workspace,
      })
    );

    // Ctrl+C 或进程退出时清理
    process.on('SIGINT', () => {
      unmount();
      process.exit(0);
    });
  }
}
```

### 8.2 完整的 ChatRenderer 时序可视化

```typescript
// ============================================================
// 使用示例：手动构造一个完整回合的 session 数据来验证渲染
// ============================================================

import { render, Static, Text, Box, Spinner } from 'ink';
import React from 'react';

// 模拟一个完整回合的 session:
const demoSession: SessionState = {
  turns: [
    // ── 用户消息 ──
    {
      id: 'turn-1',
      role: 'user',
      blocks: [],
      finished: true,
      // 注意：用户消息不通过 Block 渲染，直接渲染为特殊样式
    },
    // ── AI 回复（当前进行中）──
    {
      id: 'turn-2',
      role: 'assistant',
      blocks: [
        // thinking（已完成 → frozen）
        { id: 'b1', type: 'thinking', status: 'done', content: '分析函数结构...' },
        // 第一段文本（已完成 → frozen）
        { id: 'b2', type: 'text', status: 'done', content: '我来分析 app.ts 中的逻辑。\n这个函数有三个问题：\n1. 缺少类型定义\n2. 未处理边界条件\n3. 性能不佳' },
        // 工具调用（已完成 → frozen）
        { id: 'b3', type: 'tool_call', status: 'done', tool: 'read_file', input: { path: 'src/utils.ts' }, output: 'export function helper(...) { ... }' },
        // 第二段文本（正在流式输出 → active）
        { id: 'b4', type: 'text', status: 'streaming', content: '基于 utils.ts 的代码，我建议用 hooks 重写，具体来说：\n\n```tsx\nconst useApp = () => {\n  const [state, setState] = useS' },
      ],
      finished: false,
    },
  ],
  pendingConfirm: null,
};

// 渲染效果：
//
//  You: 重构 app.ts                           ← Static
//  ──────────────────────────────────
//  🤔 Thinking complete                       ← Static
//  📝 我来分析 app.ts 中的逻辑。                ← Static
//     这个函数有三个问题：                      ← Static
//     1. 缺少类型定义                          ← Static
//     2. 未处理边界条件                        ← Static
//     3. 性能不佳                              ← Static
//  🔧 read_file("src/utils.ts") [✓ done]      ← Static
//  ┌─ output ─                                ← Static
//  export function helper(...) { ... }         ← Static
//  └──────────                                ← Static
//  ──────────────────────────────────
//  📝 基于 utils.ts 的代码，我建议用 hooks...   ← Dynamic (只有这几行在重绘)
//     ```tsx                                   ← Dynamic
//     const useApp = () => {                   ← Dynamic
//       const [state, setState] = useS│         ← Dynamic
//
//  > _                                         ← 输入框

render(
  React.createElement(function Demo() {
    return (
      <Box flexDirection="column">
        <ChatRenderer session={demoSession} />
        <ChatInput onSubmit={console.log} disabled={false} />
      </Box>
    );
  })
);
```

---

## 附录 A：依赖清单

```json
{
  "dependencies": {
    "@oclif/core": "^4.x",
    "ink": "^5.x",
    "ink-spinner": "^5.x",
    "ink-text-input": "^5.x",
    "ink-select-input": "^5.x",
    "react": "^19.x"
  },
  "devDependencies": {
    "@types/react": "^19.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

> **注意**：Ink v5 要求 React 18+，且依赖 Yoga 布局引擎（C++ 原生模块）。Windows 上可能需要安装 `windows-build-tools`。

## 附录 B：关键概念速查

| 概念 | 含义 | 对应的 Ink API |
|---|---|---|
| Block | Agent 输出的最小渲染单元 | `AgentBlock` 类型 |
| Turn | 一次用户消息 → AI 回复的完整回合 | `Turn` 类型 |
| Frozen | 已完成、推入 Static、不再重绘 | `<Static items={}>` |
| Active | 进行中、参与每帧 diff | 普通 JSX 元素 |
| rAF 节流 | 用 requestAnimationFrame 缓冲 token | `useTextBuffer` hook |
| 确认挂起 | 整个 TUI 暂停等待用户 y/n | `ConfirmBlock` + `pendingConfirm` |
