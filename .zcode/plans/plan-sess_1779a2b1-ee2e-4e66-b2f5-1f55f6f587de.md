# 修复流式工具调用出现 unknown 工具(多余 ToolEvent)

## 回答你的问题

**"这个 unknown 工具是什么?是返回的工具状态吗?"**

不是工具状态。它是一个**多余的、错误创建的 ToolEvent**。根因:

OpenAI 流式协议里,一次工具调用分两种 chunk 交替到达:
1. **首个 chunk**:同时带完整 `tool_calls`(有 `name`="ls"、`id`="call_00_...")和 `tool_call_chunks`(也有 name/id)
2. **后续 chunks(参数流式)**:`tool_calls` 为空(因为 args 还不完整 LangChain 解析不出来),只有 `tool_call_chunks` 带 `args` 增量片段,**且这些片段只有 `index`(如 0),没有 `id` 也没有 `name`**

我的 accumulator 有两个独立分支处理这两种形态,但**没建立关联**:
- toolCalls 分支(第 135 行)用 `tc.id` 创建 ToolEvent A(name="ls")✓
- tool_call_chunks 分支(第 170 行)因为后续片段没有 id,用 `tcc.id ?? nextId()` 生成随机 id,创建了**全新的 ToolEvent B**(name="unknown")✗

**这个 unknown 就是 ToolEvent B** —— 一个本不该存在的重复工具调用。刷新后消失,是因为持久化的完整消息只有 tool_calls(已聚合,name="ls"),没有这个多余的 unknown。

## 修复方案

**核心:让 toolCalls 分支注册 `streamingToolByIndex`,后续无 id 的 tool_call_chunks 通过 `index` 找回同一个 ToolEvent。**

### 改造 1:toolCalls 分支(第 135-162 行)

创建 ToolEvent 后,**同时按数组位置(index)写入 `streamingToolByIndex`**,让后续的 tool_call_chunks 能通过 index 找到它。OpenAI 流式协议的 `index` 就是工具调用在数组中的位置。

```ts
toolCalls.forEach((tc, arrayIndex) => {
  const id = (tc.id as string) ?? this.nextId("tc");
  const name = (tc.name as string) ?? "unknown";
  const args = (tc.args as Record<string, unknown>) ?? {};
  if (!this.toolIndex.has(id)) {
    // 创建 ToolEvent(name="ls",不是 unknown)
    ...
  }
  // ★ 新增:按 arrayIndex 注册到 streamingToolByIndex
  if (!this.streamingToolByIndex.has(arrayIndex)) {
    this.streamingToolByIndex.set(arrayIndex, { id, name, argsStr: ... });
  }
});
```

### 改造 2:tool_call_chunks 分支(第 170-213 行)

**优先按 `tcc.index` 查找 `streamingToolByIndex`**,找到已有 bucket 就更新(不会创建新的 unknown ToolEvent);只有真正全新的 index 才创建。

当前逻辑第 175-191 行 `if (!bucket)` 块会盲目创建,需要改为:**先按 index 查 streamingToolByIndex,有就复用,没有才新建**。由于改造 1 已经注册了 bucket,后续片段会直接命中复用,不再产生 unknown。

### 效果

流式过程中:
- 第 1 个 chunk:toolCalls 分支创建 ToolEvent(name="ls")+ 注册 index→bucket
- 第 2+ chunks:tool_call_chunks 分支按 index 找到 bucket,更新 args,**不再创建新 ToolEvent**
- 结果:只有一个 "ls" 工具卡片,没有多余的 unknown

## 影响范围

- **改动**:`web/src/components/toolcalls/TurnEventAccumulator.ts`(两个分支)
- **不动**:engine.ts、server、其他前端组件
- **验证**:web tsc --noEmit + vite build + 实际对话测试(流式时不再出现 unknown,刷新前后一致)

## 风险

低。纯前端逻辑修复,不涉及数据流或协议。最坏情况是某些 provider 的 index 行为不同,但 OpenAI 协议的 index 语义是标准的(数组位置),覆盖面广。