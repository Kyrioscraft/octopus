## 现状

本轮会话中，针对"对话内容没有根据宽度自适应换行"的问题，我已通过浏览器 DOM 测量完成了**根因诊断**并**应用了修复代码**（plan mode 是在修复后才激活的）。当前状态：代码已改 + `tsc --noEmit` 通过 + CSS 选择器经 Explore agent 确认与 antd 5.29.3 的真实 DOM 结构匹配，但**尚未在浏览器中刷新验证最终渲染效果**。

## 根因（已确认）

浏览器测量数据：turn 容器 `clientWidth: 521px`，但内部最宽的 `.tool-call-card` / `<Collapse>` 宽达 `640px`，溢出约 120px。

- 长命令行（如 `命令|cd D:\test\t-space\news_crawler && python -c "..."`）出现在工具卡片的 Ant Design `<Collapse>` header 中。
- `.tool-call-card`、`<Collapse>`、`.ant-collapse-header`、`.ant-collapse-header-text` **整条链都没有 `max-width` 约束**。Ant Collapse header 是 `display: flex; flex-wrap: nowrap`，被 header 里的长命令文本撑开到 640px。
- 父级 turn 容器虽有 `maxWidth: 100%`，但约束不住被内容撑开的 block/flex 子元素——子元素溢出而非收缩换行，内容被 `overflowX: hidden` 裁切（看起来"没有自适应"）。

## 已应用的修复（3 个文件）

| 文件 | 改动 | 作用 |
|------|------|------|
| `web/src/components/toolcalls/ToolCallCard.tsx` | `.tool-call-card` 加 `maxWidth: "100%", minWidth: 0` | 卡片根容器受列宽约束 |
| `web/src/components/toolcalls/TurnTimeline.tsx` | 根容器加 `maxWidth: "100%", minWidth: 0` | turn 容器约束内部工具卡片 |
| `web/src/styles/theme.css` | 全局规则：`.tool-call-card` + `.ant-collapse` + `.ant-collapse-header` + `.ant-collapse-header-text` 全链 `max-width: 100%; min-width: 0`（header-text 额外 `overflow: hidden`） | 强制 Ant Collapse 整条链受父级宽度约束 |

效果：折叠态的长命令会按容器宽度**省略号截断**（header `<code>` 本就是 `whiteSpace: nowrap; textOverflow: ellipsis`，这是合理的折叠态行为）；展开态 body 内的 `pre`（已有 `white-space: pre-wrap; word-break: break-word`）会正常换行。整条链不再被内容撑破，对话内容随列宽自适应。

## 待执行（需退出 plan mode）

仅剩一步：**浏览器刷新验证**。
1. `tab.reload()` 刷新页面
2. 重新测量 turn 容器：确认 `scrollWidth ≤ clientWidth`（无横向溢出）
3. 如有残留溢出元素，定位并补充约束

请确认后我将完成浏览器验证，若发现问题会补充修复。