# 统一"向用户提问"机制 —— 输入框变身方案（修订版）

## 设计核心思想

**用户的输入反馈只有一种语义**——无论是发新消息、批准工具、选方案、回答澄清问题，本质都是"用户告诉 agent 下一步该做什么"。所以：

- 当 agent 需要用户介入时，**底部输入框区域就地变身**为提问/选项 UI
- 变身期间 TextArea `disabled`（沿用现有 `busy` 机制，用户无法输入新消息——语义自洽，因为回答提问就是当前唯一的"输入"任务）
- 多选项时输入框区域**随内容自动增高**（沿用现有 `flex-direction: column` + flex 布局，无 `position: fixed`，无硬编码高度）
- 用户做出选择后，输入框变回正常形态，resume 流继续

**业界对标**：ZCode 的 AskUserQuestion 就是在输入区呈现选项卡片；ChatGPT 的 follow-up suggestions、Cursor 的 inline permission 都遵循"输入区即反馈区"原则。

---

## 一、三种 `kind` 的统一提问（与上版相同，复用协议设计）

所有用户介入场景统一为 NDJSON status `ask_user_question_required` + payload 判别字段 `kind`：

| kind | 触发场景 | 输入框变身形态 |
|---|---|---|
| `tool_approval` | LangChain HITL 中断（执行命令/写文件等） | 警告色卡片 + 工具参数摘要 + [批准][拒绝][本次会话都批准] |
| `discussion` | agent 调 `ask_user_question` 带多选项 | 问题文本 + Radio/Checkbox 选项列表 + [其他…]自由输入（allow_other）+ [提交] |
| `clarify` | agent 调 `ask_user_question` 无选项 | 问题文本 + 单行/多行输入框 + [提交] |

判别优先级：`interrupt.value.kind` > 有 `actionRequests` → tool_approval > 有 `options` → discussion > 否则 clarify。

---

## 二、协议层（tentacle）—— 与上版完全一致

**`tentacle/src/types.ts`** 新增类型：
```ts
export interface QuestionOption { label: string; value: string; description?: string; }
export interface AskQuestion {
  question_id: string;        // 稳定 id（由 core 写入 interrupt.value，不再每次 uuid）
  question: string;
  header?: string;            // ≤12 字 chip 标题
  options?: QuestionOption[]; // 缺省 = clarify
  multi_select?: boolean;
  allow_other?: boolean;
  context?: {                 // 仅 tool_approval
    actionRequests?: Array<{ name: string; args: Record<string, unknown>; description?: string }>;
    source?: string;
    reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[] }>;
  };
}
export interface AskUserQuestionPayload {
  kind: "tool_approval" | "discussion" | "clarify";
  questions: AskQuestion[];
  thread_id: string;
}
export interface ResumeRequestBody {
  approved?: boolean;         // 向后兼容
  kind?: "tool_approval" | "discussion" | "clarify";
  decisions?: Array<{ type: "approve" } | { type: "reject"; message?: string } | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }>;
  answers?: Array<{ question_id: string; selection?: string | string[]; text?: string }>;
}
```
- `StreamEvent.questions: AskQuestion[]`（强类型化，原 `unknown[]`）
- 显式声明 `kind?`、`actionRequests?`、`source?`、`thread_id?`

**`tentacle/src/client.ts`**：`streamAgentResume(threadId, body: ResumeRequestBody, opts?)`，保留 `streamAgentResumeLegacy(threadId, approved)` 兼容包装。

---

## 三、Server + Core 层 —— 与上版一致

- **`core/src/tools.ts`（或新 `core/src/tools/ask_user_question.ts`）**：新增 `ask_user_question` 工具，内部调 langgraph `interrupt({kind, questions: tagged})`，返回 `JSON.stringify(answers)` 给模型。仅在 `interactive` 模式注入 graph tools。
- **`core/src/agent.ts`**：tools 列表加入 `ask_user_question`；改完调 `clearGraphCache()`。
- **`server/src/services/chat.service.ts`**：
  - `buildHITLQuestions` → `buildAskPayload`：读 `interrupt.value.kind`，tool_approval 时从 `reviewConfigs.allowedDecisions` 动态生成 options（不再写死），多个 actionRequests 拆成多个 question；`question_id` 从 interrupt.value 取（不再每次 uuid）
  - `normalizeResumeInput` 重写：接收 `ResumeRequestBody`，tool_approval 转 `{decisions}`，discussion/clarify 转 `{answers}`
  - `ResumeInput.approved` → `resumeBody: ResumeRequestBody`
- **`server/src/routes/chat.ts`**：resume handler body 扩展为 `ResumeRequestBody`，旧 `{approved}` 自动补 `kind:"tool_approval"`。

---

## 四、前端 UI 改造（重点：输入框变身）

### 4.1 状态升级：`approval` → `ask`

**`web/src/pages/Chat.tsx`** 当前 L63：
```ts
const [approval, setApproval] = useState<any>(null);
```
改为类型化的提问 state：
```ts
const [ask, setAsk] = useState<AskUserQuestionPayload | null>(null);
```
- `busy` 期间 `ask` 非 null 时，输入框区域显示提问 UI；TextArea 已被 `disabled={busy}` 锁定（L471），无需额外处理
- 提问期间发送按钮（L544-569）的状态由 `busy=true` 切到 Pause 图标——但提问态下应禁用停止（agent 在等用户，不在生成）。新增判断：`busy && ask` 时不显示停止按钮，提问 UI 自带提交按钮

### 4.2 inputBar 区域变身

**关键设计**：不替换 `inputBar` 变量本身，而是在它的**两个渲染位置**（欢迎屏 L673、底部 L824）外层加一个分支：
```tsx
{ask ? <AskPanel payload={ask} onResolve={resolve} /> : inputBar}
```

但更优雅的做法是**抽一个 `<ChatInputArea>` 组件**，内部根据 `ask` 切换内容，避免两处重复判断。鉴于现有代码用 `inputBar` 复用变量已经成形，最小改动是：

**修改两处渲染（L673、L824）**：
```tsx
{ask ? (
  <AskPanel payload={ask} onResolve={(body) => resolve(body)} />
) : (
  inputBar
)}
```

`AskPanel` 复用 `inputBar` 的外层容器样式（`borderRadius:13, border, boxShadow, padding`），保证视觉一致——用户感觉"输入框还是那个输入框，只是内容变了"。

### 4.3 新组件 `web/src/components/AskPanel.tsx`

外层容器直接套用 inputBar 的样式 token，内部按 `kind` 分发：

```tsx
function AskPanel({ payload, onResolve }: { payload: AskUserQuestionPayload; onResolve: (b: ResumeRequestBody) => void; }) {
  // 一个 payload 可能有多个 questions（多个工具同时审批/多个澄清问题）
  // 每个 question 独立收集答案，底部统一一个提交按钮
  return (
    <div style={{ /* 复用 inputBar 容器: borderRadius:13, border, boxShadow, padding */ }}>
      <AskHeader kind={payload.kind} />                    {/* 图标 + 标题 chip */}
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {payload.questions.map(q => (
          <QuestionRow key={q.question_id} kind={payload.kind} q={q} ... />
        ))}
      </div>
      <AskFooter kind={payload.kind} onSubmit={...} />      {/* 提交按钮，替代发送按钮位置 */}
    </div>
  );
}
```

**三种 QuestionRow 形态**：

**(a) `tool_approval`**（替换 ApprovalDialog）：
```
┌──────────────────────────────────────────┐
│ ⚠ 需要批准 · execute                       │ ← 警告色 header
│ ┌─ 命令 ─────────────────────────────┐    │
│ │ rm -rf node_modules                 │    │ ← 折叠可看完整 args（monospace）
│ └─────────────────────────────────────┘    │
│ (工具栏位置保留访问模式/模型 select?)        │
│ [拒绝]              [批准] [本次会话都批准] │ ← decisions 按钮（按 allowedDecisions 动态）
└──────────────────────────────────────────┘
```
- 黄色 `--color-warning-500` header
- 多个工具逐个成行，每个独立决策
- resolved 提交后整个 AskPanel 消失，输入框恢复

**(b) `discussion`**：
```
┌──────────────────────────────────────────┐
│ 💬 方案选择                                 │
│ 前端框架选哪个？                           │
│  ○ React  — 生态成熟                       │
│  ○ Vue    — 学习曲线平缓                   │
│  ○ Svelte — bundle 小                      │
│  ○ 其他…  [自由输入框            ]          │ ← allow_other 时
│                            [提交选择 →]    │
└──────────────────────────────────────────┘
```
- Radio（单选）/ Checkbox（多选，antd）
- 选项多时容器自动增高（flex column + 无 max-height）

**(c) `clarify`**：
```
┌──────────────────────────────────────────┐
│ ❓ 需要澄清                                 │
│ 你希望数据库用哪种存储引擎？               │
│ ┌──────────────────────────────────────┐  │
│ │ （TextArea, autoSize minRows:2）      │  │ ← 复用现有 TextArea 配置
│ └──────────────────────────────────────┘  │
│                              [提交 →]      │
└──────────────────────────────────────────┘
```

### 4.4 `resolve(body)` 回调

**`web/src/pages/Chat.tsx`** 重写当前 `resume(approved)`（L336-356）为 `resolve(body: ResumeRequestBody)`：
```ts
const resolve = useCallback(async (body: ResumeRequestBody) => {
  if (!activeThreadId) return;
  setAsk(null);                          // AskPanel 消失，输入框恢复（但 busy 仍 true）
  // 关键：不再新增空 assistant 消息（旧 L339 的 setMsgs(p=>[...p,a]) 是 bug）
  // 复用当前 streaming 消息 + 同一个 accumulator，让 resume 流继续
  const controller = new AbortController();
  abortRef.current = controller;
  try {
    await doStream(
      await sdk.streamAgentResume(activeThreadId, body, { signal: controller.signal }),
      activeThreadId
    );
  } catch (err: any) {
    if (err?.name !== "AbortError") setBusy(false);
  } finally {
    if (abortRef.current === controller) abortRef.current = null;
  }
}, [activeThreadId, doStream]);
```

**doStream 改造**（L235-237）：
```ts
case "ask_user_question_required":
  setAsk({
    kind: ev.kind ?? "tool_approval",  // 判别
    questions: (ev.questions as AskQuestion[]) ?? [],
    thread_id: (ev.thread_id as string) ?? activeThreadId ?? "",
  });
  return;  // 保持 busy=true，等用户在 AskPanel 操作
```

### 4.5 时间线呈现提问上下文（轻量增强）

AskPanel 是"操作区"，但用户在消息流里也需要看到"agent 正在等我回答什么"。最小方案：

- 收到 `ask_user_question_required` 时，往当前 streaming 消息的 `events[]` 末尾追加一个**只读**的 `AskEvent`（仅显示提问文本，不含交互按钮），让时间线留痕
- 用户在底部 AskPanel 操作后，把这个 AskEvent 标记 `resolved=true`，显示"✓ 已批准/✗ 已拒绝/已选: React"摘要
- 这样消息流有完整因果链，底部 AskPanel 是唯一交互入口，职责清晰

`web/src/components/toolcalls/types.ts` 加 `AskEvent`（type: "ask"，只读），`TurnEventAccumulator` 加 `consumeAskReadOnly(payload)`，`EventRow` 加 `case "ask"` 渲染只读摘要。

### 4.6 删除旧组件

- **删除 `web/src/components/ApprovalDialog.tsx`**（76 行）
- 删除 `Chat.tsx` 的 `approval` state（L63）、`{approval && <ApprovalDialog/>}` 渲染（L836-843）、旧 `resume(approved)` 逻辑

### 4.7 "本次会话都批准"实现（tool_approval 增强项）

前端维护一个 `useState<Set<string>>` 会话级 allowlist（工具名集合）。用户点"本次会话都批准"时：
- 把工具名加入 allowlist
- 立即 approve 当前请求
- 后续该工具的 tool_approval chunk 到达时，前端**自动 resolve(approve)** 不弹 AskPanel（沿用 doStream 的 setAsk 逻辑前先查 allowlist）
- 刷新页面即失效（不入 store、不入 DB——持久化偏好属下一阶段）

---

## 五、向后兼容

- resume body：旧 `{approved}` 自动补 `kind:"tool_approval"` + 转 `{decisions:[{type}]}`（server 端 normalizeResumeInput 处理）
- NDJSON：旧前端读 `questions[].options` 仍存在；`kind` 是新增可选字段
- tentacle：`streamAgentResumeLegacy` 保留一个版本周期
- LangChain `humanInTheLoopMiddleware` 行为完全不改；`ask_user_question` 工具走独立 `interrupt()` 路径

---

## 六、实施顺序（依赖链 core→tentacle→server→web）

1. **tentacle**：加 `AskQuestion`/`ResumeRequestBody`/`AskUserQuestionPayload` 类型；`streamAgentResume(threadId, body)`；legacy 包装。`tsc --noEmit`。
2. **core**：新增 `ask_user_question` 工具（`interrupt({kind, questions})`）；agent.ts tools 列表注入（interactive 模式）；`clearGraphCache()`。`tsc --noEmit`。
3. **server**：`buildAskPayload`、`normalizeResumeInput` 重写、`ResumeInput` 改型、resume 路由 body 扩展。`tsc --noEmit`。
4. **web**：
   - `toolcalls/types.ts` 加 `AskEvent`
   - `TurnEventAccumulator.ts` 加 `consumeAskReadOnly`
   - 新建 `components/AskPanel.tsx`（三种 kind + QuestionRow + AskFooter）
   - `EventRow.tsx` 加 `case "ask"`（只读摘要）
   - `Chat.tsx`：`approval`→`ask` state；doStream 改 setAsk；两处 inputBar 渲染位加 `{ask ? <AskPanel/> : inputBar}`；`resume`→`resolve(body)` 复用 accumulator；会话级 allowlist
   - 删除 `ApprovalDialog.tsx`
   - `tsc --noEmit`
5. **手测**（server 5050 + web 5173，interactive 模式）：
   - 触发 `execute` → 输入框变警告卡 → 批准/拒绝/本次会话都批准 → 流继续
   - agent 调 `ask_user_question`（discussion）→ 输入框变选项 → 选完提交 → agent 收到 answers
   - clarify 自由文本路径
   - 嵌套中断（一次回答后又触发下一个 ask）
   - 高度自适应（多选项时输入框区域自然增高，不挤压消息流）

---

## 七、明确不做（排除项）

- **不做持久化"总是允许"偏好**（需 DB schema 改动，下一阶段；本次仅会话级 allowlist）
- **不做 HITL `edit` 决策的 UI**（协议层支持，UI 不渲染编辑器，工作量大留后续）
- **不引入新状态管理库**（Context/props 足够；ask state 是 ChatPage 局部，与现有架构一致）
- **不改 LangChain 中间件**（被动审批原路，主动提问走独立 interrupt）
- **不动 Zustand store**（消息本就不在 store，ask 也保持局部）

---

## 关键文件清单

| 文件 | 改动 |
|---|---|
| `tentacle/src/types.ts` | 新增 AskQuestion/ResumeRequestBody/AskUserQuestionPayload；StreamEvent.questions 强类型 |
| `tentacle/src/client.ts` | streamAgentResume(threadId, body) + legacy 包装 |
| `core/src/tools.ts` 或 `core/src/tools/ask_user_question.ts` | **新增** ask_user_question 工具 |
| `core/src/agent.ts` | tools 注入（interactive）+ clearGraphCache() |
| `server/src/services/chat.service.ts` | buildAskPayload、normalizeResumeInput 重写、ResumeInput 改型 |
| `server/src/routes/chat.ts` | resume body 扩展 + 兼容转换 |
| `web/src/components/AskPanel.tsx` | **新建**，三种 kind 输入框变身 UI |
| `web/src/components/toolcalls/types.ts` | 新增 AskEvent（只读时间线留痕） |
| `web/src/components/toolcalls/TurnEventAccumulator.ts` | consumeAskReadOnly |
| `web/src/components/toolcalls/EventRow.tsx` | case "ask" 只读摘要 |
| `web/src/pages/Chat.tsx` | approval→ask state、doStream setAsk、inputBar 两处分支、resume→resolve、会话 allowlist |
| `web/src/components/ApprovalDialog.tsx` | **删除** |

类型检查：各包 `npm run lint`（= `tsc --noEmit`，无测试套件）。
