## 实现方案：常规设置中添加"思考显示"开关

### 概述

在"常规"设置页面添加一个"思考显示"开关，默认关闭，用于控制对话界面中是否显示思考（reasoning）内容。这是一个纯 UI 偏好，存储在 localStorage 中（与主题模式一致），不涉及服务端变更。

### 修改文件（3 个：1 新建 + 2 修改）

#### 1. 新建 `web/src/stores/settings.ts` — Zustand 状态管理

- 遵循 `useThemeStore`（`web/src/stores/theme.ts`）的写法模式
- Store 类型：`{ showThinking: boolean; setShowThinking: (v: boolean) => void }`
- 默认值：`false`（关闭）
- 持久化到 `localStorage`，key: `octopus.show-thinking`
- `readStored()` 在初始化时读取，非法值 fallback 到 `false`

#### 2. 修改 `web/src/components/settings/GeneralSettingsSection.tsx` — 添加开关 UI

- 导入 `useSettingsStore` 和图标（`BulbOutlined`）
- 在"外观"卡片和"工具开关"卡片之间插入一个新的"显示"卡片，包含：
  - 图标：灯泡（`BulbOutlined`）
  - 标题：**思考显示**
  - 描述：在对话中显示智能体的思考过程
  - `Switch` 开关：绑定 `useSettingsStore` 的 `showThinking` / `setShowThinking`
- 该卡片不调用服务端 API（纯客户端，与 Appearance 卡片一致）

#### 3. 修改 `web/src/components/toolcalls/EventRow.tsx` — 条件渲染

- 导入 `useSettingsStore`
- 在 `case "reasoning"` 分支中检查 `showThinking` 标志：
  - `true` → 正常渲染 `<ReasoningBlock>`
  - `false` → `return null`（不渲染任何内容）
- 这同时覆盖流式消息和历史消息（两者都通过 `EventRow` 渲染 reasoning 事件）

### 不修改的部分

- **服务端**：无需变更（纯 UI 偏好，不影响 Agent 行为）
- **tentacle 类型**：无需变更（不通过 API 传输）
- **`ReasoningBlock.tsx`**：无需变更（由调用方决定是否渲染）
- **`TurnTimeline.tsx`**：无需变更（事件仍正常传递，仅在最终的 EventRow 中拦截）

### 验证

- `cd web && npm run lint`（即 `tsc --noEmit`）验证类型检查通过
- 无需测试运行器（项目当前未配置）