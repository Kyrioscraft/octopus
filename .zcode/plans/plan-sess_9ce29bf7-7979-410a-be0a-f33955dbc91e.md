# 布局架构确认 + 修复侧边栏重渲染

## 你的架构直觉是对的——现状已经是 Vue-router 式的局部导航设计
React Router v6 的结构与 Vue 的 `<router-view>` 一致:
- `App.tsx`:`<Route element={<AppLayout/>}>` 包裹子路由 → `AppLayout` 是**布局组件**(等价 Vue 的 layout),内部渲染 `<Sidebar/>` + `<Outlet/>`(等价 `<router-view/>`)。
- `ChatPage` 等是渲染在 `<Outlet/>` 里的**路由视图**。
- **导航(SPA `navigate`)本身不会重渲染侧边栏**——只有 `<Outlet/>` 里的视图换。`?thread=` 这种 query 参数变化也不改路由匹配(`/` 仍是 `/`),ChatPage 保持挂载,只通过 `useSearchParams` 更新。

所以**设计是合理的**,问题不在布局,而在 Sidebar 代码里用了 **`window.location.href`(整页硬刷新)**,绕过了路由,导致整个 App 重新挂载——侧边栏自然也重渲染。这正是之前几个“切换会闪”的根因。

## 修复(让导航回归 SPA 局部替换)

### `web/src/components/Sidebar.tsx`
把所有硬刷新换成已有的 react-router `navigate()`(`useNavigate` 已导入,switchWorkspace 已在用):
1. 对话历史项点击 / 搜索跳转 `jumpToThread`:`navigate("/?thread=" + id)`(替代 `window.location.href`)
2. 新建对话 `handleNewChat`:`navigate("/agent")`
3. 删除当前对话后跳转:`navigate("/agent")`

### `web/src/pages/Chat.tsx`
SPA 导航不重挂载 ChatPage,所以现在“只在挂载时读 `?thread=`”的 effect 在切对话时不会触发。让 Chat 响应 `thread` query 变化:
- 把“读 `searchParams.get('thread')` → setActiveThreadId + load(tid)”从挂载 effect 拆出,改为依赖 `searchParams`(或单独一个 effect 监听 thread id),URL `?thread=` 变化时重新加载该对话历史 + 清空旧消息。

## 结果
- 点击对话历史 → 仅 `<Outlet/>`(聊天区)重渲染并加载该对话;侧边栏不重渲染,只有选中态更新。
- 新建/删除对话同理。
- 切换工作区(已改)也走 SPA,不再闪。
- 整体布局(AppLayout + Outlet)保持现状,无需重构。

## 验证
- `web` `tsc --noEmit`
- 手测:点不同对话(聊天区切换、侧边栏不闪)、新建对话、删除对话、切换工作区。