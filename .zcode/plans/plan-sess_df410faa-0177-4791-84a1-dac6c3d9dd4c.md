# 扩展管理侧边栏导航重构

## 概述
进入扩展管理时，**整个侧边栏被替换**为专用的扩展管理侧边栏：顶部"返回对话"按钮，下方 Skills / MCP / 子智能体作为一级菜单项。内容区每个页面独立，带各自标题，不再用 Tab 切换。

## 涉及文件

### 1. 新建 `web/src/components/ExtensionsSidebar.tsx`
专用侧边栏组件（镜像现有 Sidebar 的视觉风格）：
- **顶部**：返回对话按钮（`ArrowLeftOutlined` + "返回对话"），导航到 `/`，样式类似"创建新对话"按钮的 ghost 风格
- **菜单区**：3 个一级菜单项，复用现有 Sidebar 导航项的样式（36px 高、圆角 8、hover/active 态用 `var(--main-color)`/`var(--main-20)`）：
  - `BookOutlined` + "Skills" → `/extensions/skills`
  - `ApiOutlined` + "MCP" → `/extensions/mcp`
  - `RobotOutlined` + "子智能体" → `/extensions/subagents`
- **active 判定**：根据 `useLocation().pathname` 前缀匹配高亮当前项
- **底部**：保持与原 Sidebar footer 一致的间距（可留空或简化）
- 整体布局：`display:flex; flexDirection:column; height:100%`，菜单区居中靠上

### 2. 修改 `web/src/layouts/AppLayout.tsx`
根据当前路由决定渲染哪个侧边栏：
```tsx
const location = useLocation();
const isExtensions = location.pathname.startsWith("/extensions");
// <Sider>{isExtensions ? <ExtensionsSidebar /> : <Sidebar />}</Sider>
```
Sider 本身的样式（width 252、背景、边框）保持不变。

### 3. 修改 `web/src/App.tsx`（路由拆分）
- 移除单一 `/extensions` → `<ExtensionsPage>`
- 改为：
  - `/extensions` → `<Navigate to="/extensions/skills" replace />`（重定向）
  - `/extensions/skills` → `<ExtensionsPage tab="skills" />`
  - `/extensions/mcp` → `<ExtensionsPage tab="mcp" />`
  - `/extensions/subagents` → `<ExtensionsPage tab="subagents" />`
  - 详情路由 `/extensions/skill/:name`、`/extensions/mcp/:name`、`/extensions/subagent/:name` 保持不变
- `ExtensionsPage` 改为接受 `tab` prop（由路由注入），内部不再用 `searchParams` 控制 Tab

### 4. 重构 `web/src/pages/Extensions.tsx`
- **移除** Segmented Tab 切换栏和 `useSearchParams`
- **Props**：`{ tab: "skills" | "mcp" | "subagents" }`
- **标题栏**：根据 tab 显示对应标题（"扩展管理 · Skills" / "· MCP" / "· 子智能体"），保留搜索框
- **内容区**：根据 tab 渲染对应的 `SkillCardList` / `McpCardList` / `SubagentCardList`
- **数据加载**：根据 tab 只加载对应数据（skills tab 加载 skills+builtin，mcp tab 加载 mcp，subagents tab 加载 subagents）。用 `useEffect` 依赖 `tab` 触发对应加载
- `onReload` 回调保持各 Tab 自己的 reload 函数

### 5. 各详情页返回导航调整
当前详情页返回按钮导航到 `/extensions?tab=xxx`。改为：
- `SkillDetail.tsx`：`navigate("/extensions/skills")`
- `McpDetail.tsx`：`navigate("/extensions/mcp")`
- `SubagentDetail.tsx`：`navigate("/extensions/subagents")`

### 6. `web/src/components/Sidebar.tsx`（原对话侧边栏）
- 导航项"扩展管理"的点击：`navigate("/extensions")`（会被重定向到 `/extensions/skills`）——保持不变
- active 判定已有 `location.pathname.startsWith("/extensions")` 逻辑，无需改

## 不改的文件
- `ExtensionCard.tsx`、`SkillCardList.tsx`、`McpCardList.tsx`、`SubagentCardList.tsx`——这些列表组件本身不动，只由 Extensions 页面调度
- `tentacle`/`server`/`core` 后端全部不动

## 视觉效果
```
┌──────────┬──────────────────────────┐
│ ← 返回对话 │  扩展管理 · Skills  [搜索] │
│          │──────────────────────────│
│ 📖 Skills │  ┌────┐ ┌────┐ ┌────┐    │
│ 🔌 MCP    │  │card│ │card│ │card│    │
│ 🤖 子智能体│  └────┘ └────┘ └────┘    │
│          │                          │
│ (空/留白) │                          │
└──────────┴──────────────────────────┘
```

## 验证
`cd web && npm run lint`
视觉：进入扩展管理，侧边栏整体替换；点"返回对话"回主页；三个菜单项切换；详情页返回正确回到对应列表。