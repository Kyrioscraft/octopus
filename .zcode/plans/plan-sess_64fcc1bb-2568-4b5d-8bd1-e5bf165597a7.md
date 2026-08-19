# 在对话侧边栏添加全局搜索菜单

## 目标
在 `Sidebar.tsx` 的"扩展管理"导航项**上方**新增一个"搜索"菜单项，点击后弹出 antd `Modal`，可搜索 **页面功能（导航）** 和 **对话历史（会话标题）** 两类内容，并支持 `Ctrl/Cmd+K` 快捷键触发。

## 设计决策（已与用户确认）
- 功能搜索范围：**页面导航**（静态菜单项，点击跳转）
- 对话历史搜索：**仅搜索会话标题**（基于 store 中已加载的 `threads`，点击跳转到对应会话）
- 快捷键：**支持 Ctrl/Cmd+K**
- 模态框渲染位置：**Sidebar 组件内部**（与现有重命名 Modal 一致）

## 改动文件
仅 `web/src/components/Sidebar.tsx`（单文件改动，无后端、无路由、无 store 变更）

## 实现细节

### 1. 新增导航菜单项（位于"扩展管理"上方）
修改模块级 `navItems` 数组，在最前面加入搜索项：
```tsx
const navItems = [
  { key: "search", icon: <SearchOutlined />, label: "搜索" },          // 新增
  { key: "extensions", icon: <AppstoreOutlined />, label: "扩展管理" },
];
```
并在导航项 `onClick` 的 `if` 链中增加 `search` 分支：点击时**不跳转路由**，而是 `setSearchOpen(true)`（`navKey` 不变，保持不高亮，因为它是一个动作而非页面）。

### 2. 新增搜索状态
```tsx
const [searchOpen, setSearchOpen] = useState(false);
const [query, setQuery] = useState("");
```

### 3. Ctrl/Cmd+K 全局快捷键
新增 `useEffect` 注册 `keydown` 监听器，匹配 `(e.ctrlKey || e.metaKey) && e.key === "k"` 时 `e.preventDefault()` 并打开模态框；组件卸载时移除监听器。

### 4. 搜索数据源
**(a) 页面功能**（静态数组，内置在组件中）：
```tsx
const FEATURES = [
  { label: "新建对话", path: "/agent", icon: <MessageOutlined /> },
  { label: "扩展管理 - Skills", path: "/extensions/skills", icon: <BookOutlined /> },
  { label: "扩展管理 - MCP", path: "/extensions/mcp", icon: <ApiOutlined /> },
  { label: "扩展管理 - 子智能体", path: "/extensions/subagents", icon: <RobotOutlined /> },
  { label: "设置 - 常规", path: "/settings/general", icon: <SettingOutlined /> },
  { label: "设置 - 模型配置", path: "/settings/model", icon: <SettingOutlined /> },
];
```

**(b) 对话历史**：直接用 store 的 `threads`，按 `title.toLowerCase().includes(q)` 过滤。

### 5. 过滤逻辑
- `q = query.trim().toLowerCase()`
- 无输入时：功能列表全部展示（作为快捷入口），对话历史不展示（避免过长）
- 有输入时：两类各自过滤；空结果时显示占位文案
- 复用项目既有范式（`SkillCardList.tsx` 的 `includes()` 模式）

### 6. 模态框 UI（antd Modal + Input + 分组列表）
- `Modal`：`open={searchOpen}`，`onCancel` 关闭，`footer={null}`，`destroyOnClose`，宽度约 560px，居中，无标题栏（或用简洁标题"搜索"）
- 顶部 `Input`：`autoFocus`，`prefix={<SearchOutlined/>}`，`allowClear`，`placeholder="搜索功能或对话..."`，`onChange` 更新 `query`，`onPressEnter` 跳转第一个结果
- 内容区分两组（带小标题）：
  - **页面功能**：每项一行，左图标 + label，hover 高亮，点击 → `navigate(path)` + 关闭模态框
  - **对话历史**：每项一行，`MessageOutlined` + 标题，点击 → 复用现有逻辑（`setActiveThreadId(t.id)` + `window.location.href = /?thread=${id}`）+ 关闭模态框
- 样式沿用项目既有内联样式风格（`var(--gray-*)`、`var(--main-color)`、`borderRadius:8` 等 CSS 变量），与 Sidebar 列表项视觉一致
- 底部可加一行提示：`Ctrl/⌘ + K 快捷打开`（轻量灰色文案）

### 7. 关闭时清理
`onCancel` 中 `setQuery("")`（配合 `destroyOnClose` 自动重置，但显式清理更稳妥）。

### 8. 新增图标 import
在 `@ant-design/icons` import 中补充 `SearchOutlined`、`BookOutlined`、`ApiOutlined`、`RobotOutlined`。

## 不做的事
- 不修改后端 / 不新增搜索接口
- 不修改路由 / store / AppLayout
- 不搜索消息内容（仅标题）
- 不引入新依赖（纯 antd + 现有图标）

## 验证方式
- `cd web && npm run build`（或 `tsc --noEmit`）类型检查通过
- 手动验证：点击"搜索"菜单 → 模态框弹出；Ctrl+K 触发；输入关键字过滤功能与对话；点击结果跳转并关闭模态框