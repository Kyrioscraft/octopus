# 待办徽章 → 侧边抽屉 + Tabs（新增"待办"tab）

## 需求（已确认）
点击输入栏的待办徽章 → 打开**右侧侧边抽屉（antd Drawer）**，抽屉里用 **antd Tabs** 组织内容，**自动激活新增的"待办"tab**。在"待办"tab 里设计 todo 内容和完成状态的显示：
- 顶部**进度概览**：已完成/总数 + 进度条（完成比例填充）。
- 下方**列表行**：每项 todo 一行 = 状态图标 + content 文本 + 状态标签（待处理/进行中/已完成）；completed 项置灰+删除线。
- 抽屉结构可扩展（Tabs 便于未来加更多 tab）。

## 数据来源（已就绪）
- `todos: TodoItem[]` 已在 `Chat.tsx:163-176` 的 useMemo 推导（最后一条 assistant turn 最后一次 write_todos 的 args.todos）。
- `TodoItem`/`TodoStatus` 类型已在 `toolcalls/types.ts`。

## 改动文件

### 文件 1：`web/src/stores/chat.ts` — 新增抽屉状态
仿照 `subagentPanelOpen` 模式，新增：
```ts
/** 右侧信息抽屉是否打开（承载 Tabs：待办等）。 */
infoDrawerOpen: boolean;
setInfoDrawerOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
/** 抽屉里当前激活的 tab key（"todos" 等）。 */
infoDrawerTab: string;
setInfoDrawerTab: (v: string) => void;
```
默认 `infoDrawerOpen: false`、`infoDrawerTab: "todos"`。

### 文件 2：新建 `web/src/components/TodoPanel.tsx` — "待办"tab 内容
- Props: `{ todos: TodoItem[] }`。
- **进度概览区**：
  - 大字 `done/total` + 右侧百分比。
  - antd `Progress`（线形，percent = done/total*100，showInfo=false）颜色随完成度（全完成绿/进行中蓝/未开始灰）。
- **列表行区**（每项）：
  - 左：状态图标（✓ CheckCircleFilled 绿 / ◐ LoadingOutlined 蓝 / ○ ClockCircleOutlined 灰）。
  - 中：content 文本；completed 项置灰+删除线。
  - 右：状态标签（antd Tag，无框/淡色：已完成/进行中/待处理）。
- 空态：antd `Empty`"暂无待办"。
- 复用 `TodoBadge.tsx` 现有的 `TodoRow`/`statusVisual` 逻辑（导出复用或迁移到此）。

### 文件 3：新建 `web/src/components/InfoDrawer.tsx` — 抽屉 + Tabs 容器
- 读 store 的 `infoDrawerOpen`/`infoDrawerTab` 及 setter。
- antd `<Drawer placement="right" open={infoDrawerOpen} onClose={...} width={380}>`，`styles.body` 去默认 padding。
- 内部 antd `<Tabs activeKey={infoDrawerTab} onChange={setInfoDrawerTab} items={[{ key:"todos", label: 待办(+N 角标), children: <TodoPanel todos={todos}/> }]} />`。
- Props 接收 `todos`（由 Chat.tsx 传入）。
- Tab label 带 `N` 个待办的小角标（Badge count，仅当 todos 非空）。

### 文件 4：`web/src/components/TodoBadge.tsx` — 改为打开抽屉（不再 Popover）
- 移除 Popover，改为点击徽章 → `setInfoDrawerTab("todos")` + `setInfoDrawerOpen(true)`。
- 徽章本身（图标 + done/total）保持不变；从 store 取 setter。
- 保留 `TodoRow`/`statusVisual` 导出（供 TodoPanel 复用），或迁移到 TodoPanel（二选一，倾向迁移到 TodoPanel，TodoBadge 只保留徽章）。

### 文件 5：`web/src/pages/Chat.tsx` — 挂载抽屉 + 传数据
- import `InfoDrawer`。
- 在 `ChatPage` 根 `<div>` 下（与 SubagentPanel 同级，约 1168 行后）渲染 `<InfoDrawer todos={todos} />`。
- TodoBadge 已在 inputBar（822 行），无需改位置。

## 不做的事
- 不改 SubagentPanel/子智能体面板（独立机制，互不干扰）。
- 不改 core/server（纯前端）。
- 不改 todos 推导逻辑（已验证正确）。
- 暂不为抽屉加更多 tab（结构留好扩展点，"待办"是第一个）。

## 验证
1. `node web/node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit` 通过。
2. 浏览器实测（5173，thread_8657a87c 有真实 write_todos）：
   - 点击待办徽章 → 右侧抽屉滑出，自动在"待办"tab。
   - tab 内：顶部 5/5 进度概览 + 进度条（100% 绿）；下方 5 行 todo（全 completed，置灰+删除线 + "已完成"标签）。
   - 关闭抽屉 → 徽章仍在；再点 → 重新打开。
   - 无待办的对话 → 徽章不显示，抽屉也不触发。