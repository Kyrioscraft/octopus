# Alternate Screen + 全虚拟滚动方案

## 目标

解决"滚动条滚动时输入框跟着消失"的根本问题。切换架构:
- **从**:主屏幕 → 终端原生滚动条控制全部内容(输入框会滚走)
- **到**:alternate screen → 应用完全掌控每一行的渲染,输入框永远固定在底部

## 技术基础

Ink 7 的 `render()` 原生支持 `alternateScreen: true`:
```ts
render(<App />, { alternateScreen: true, incrementalRendering: true, patchConsole: false })
```
Ink 自动处理 `ESC[?1049h`(进入)和 `ESC[?1049l`(退出),退出后原始终端内容恢复。

alternate screen 的特性:
- ❌ 无终端 scrollback(所以 `<Static>` 不再有意义)
- ✅ 应用完全控制屏幕内容(输入框不会意外滚走)
- ✅ 标准 TUI 做法(vim/htop/lazygit/Textual 都这么做)

## 改动文件清单

### ① `tui/src/cli.ts` — 启用 alternate screen + 鼠标上报

**a) render 选项加 `alternateScreen: true`**(第 178 行附近):
```ts
const { waitUntilExit } = render(createElement(App, appProps), {
  patchConsole: false,
  incrementalRendering: true,
  alternateScreen: true,  // ← 新增
});
```

**b) 启用/关闭 SGR 鼠标上报**:
```ts
// 进入前启用鼠标追踪
process.stdout.write("\x1b[?1000h\x1b[?1006h");

try {
  const { waitUntilExit } = render(...);
  await waitUntilExit();
} finally {
  // 恢复终端状态
  process.stdout.write("\x1b[?1000l\x1b[?1006l");
  await sm.stop();
}
```

SGR 鼠标上报格式: `\x1b[<Cb;Cx;CyM` / `\x1b[<Cb;Cx;Cym`
- Cb: 按键码(0=左键, 64=滚轮上, 65=滚轮下)
- Cx/Cy: 列/行坐标

### ② `tui/src/app.tsx` — 全屏布局 + 鼠标事件解析

**a) 根布局改为全屏**:
```tsx
<Box flexDirection="column" height={rows}>
  {/* 消息区: 占满剩余空间 */}
  <Box flexGrow={1} overflow="hidden">
    <MessageList ... />
  </Box>
  {/* 输入区: 固定底部 */}
  <Box flexShrink={0}>
    <ChatInput ... />
  </Box>
</Box>
```
不再需要 `messageAreaHeight` 计算(消息区自动 `flexGrow` 填满)。

**b) 全局 useInput 解析鼠标滚轮**:
```ts
if (input.startsWith("\x1b[<")) {
  const match = input.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (match) {
    const cb = parseInt(match[1]);
    if (cb === 64) { setScrollTick(p => p - 1); return; }  // 滚轮上
    if (cb === 65) { setScrollTick(p => p + 1); return; }  // 滚轮下
    return;
  }
}
```

### ③ `tui/src/components/messages.tsx` — 纯虚拟滚动 + 滚动条

**a) 移除 `<Static>` 机制**:
- 删除 `isActive()`、`computeSplit()` 函数
- 删除 staticMessages / activeMessages 分区
- 所有消息统一进入虚拟滚动

**b) 滚动条绘制**:

在消息区右侧画滚动条(3 字符宽):
```
行内容...    │ ← 轨道
行内容...    ░
行内容...    █ ← 滑块
行内容...    ░
行内容...    │
```

计算:
```ts
const trackHeight = visibleLines - 2;  // 留 2 行给上下箭头
const total = messages.length;
const visible = ITEMS_PER_PAGE;
const thumbSize = Math.max(1, Math.floor((visible / total) * trackHeight));
const thumbPos  = Math.floor((scrollOffset / (total - visible)) * (trackHeight - thumbSize));
```

渲染(紧贴右侧):
```tsx
<Box flexDirection="row" height={maxHeight}>
  {/* 消息内容(占满左侧) */}
  <Box flexGrow={1} flexDirection="column" overflow="hidden">
    {/* 滚动指示器 + 可见消息 */}
  </Box>
  {/* 滚动条(右侧 3 字符宽) */}
  {total > visible && (
    <Box flexDirection="column" width={3}>
      <Text dimColor>▲</Text>
      {Array.from({length: trackHeight}).map((_, i) => (
        <Text dimColor key={i}>
          {i >= thumbPos && i < thumbPos + thumbSize ? "█" : "░"}
        </Text>
      ))}
      <Text dimColor>▼</Text>
    </Box>
  )}
</Box>
```

**c) 消息计数**: 不再用 `ITEMS_PER_PAGE` 按条数翻页,改用行数估算:
```ts
// 估算每条消息约占的行数
function estimateMessageLines(msg: ChatMessageData): number {
  switch (msg.role) {
    case "tool": return 1;
    case "user":
    case "assistant": return Math.max(2, Math.ceil(msg.content.split("\n").length * 0.7));
    default: return 2;
  }
}
// 遍历消息累积行数,找到 visibleLines 能容纳的起止索引
```
如果性能有问题,保持当前按条数的 `ITEMS_PER_PAGE` 方式也完全可用。

### ④ `tui/src/components/chat-input.tsx` — 无需改动

当前的三层 chrome + `input.startsWith("\x1b")` 过滤已经正确处理了 escape 序列(包括鼠标序列)。

### ⑤ 退出行为

- 用户 `/quit` 或 `Ctrl+C` → Ink 自动退出 alternate screen,恢复主屏幕
- `finally` 块关闭鼠标上报、停止 server
- 退出后终端完全是干净的主屏幕状态

## 性能考量

没有 `<Static>` 后,所有消息都在 React 树中:
- `<Message>` 已经有 `React.memo`,流式更新时只有变化的消息重渲染
- 长对话(100+ 消息): Ink 的 reconciliation 理论上能处理,但 TODO 后续可加"超过 N 条后归入折叠组"
- 滚动条用 `Array(N).fill().map()` 静态渲染,尺寸稳定时不触发更新

## 预期效果

启动后:
```
┌────────────────────────────────────────┐
│  #a1b2c3de        /project      main  │
│                                        │
│  → You: hello                      ░  │
│  ● Agent: Hi! How can I help...    █  │
│  ● Agent: (streaming response...)  ░  │
│  ▼ 5 more messages below           │  │
│                                ▲   │  │
│                                ░   │  │
│                                █   │  │
│                                ░   │  │
│                                ▼   │  │
│                                        │
│  ╭──────────────────────────────────╮ │
│  │ > _                              │ │
│  ╰──────────────────────────────────╯ │
│  normal  Shift+Tab     ✓ Ready | ...  │
└────────────────────────────────────────┘
```

- 输入框**始终在底部**,不论怎么滚动消息
- 鼠标滚轮 → 消息区上下翻页
- PageUp/PageDown/Ctrl+U/Ctrl+D → 键盘翻页
- 右侧滚动条直观显示当前位置
- 自动跟随新消息(用户在底部时)

## 不可回退的代价

- 退出后不保留对话历史在终端 scrollback(alternate screen 特性)
- 这是标准 TUI 行为(vim/htop 退出后也不留历史)
- 如需回看历史,使用应用内滚动功能

## 验证

```
cd tui && npx tsc --noEmit && npx tsc
octopus
```

测试:
1. 发送多条消息 → 消息超出可视区 → 输入框是否固定底部 ✓
2. 鼠标滚轮 → 消息区翻页 ✓
3. PageUp/PageDown → 消息区翻页 ✓
4. Ctrl+C 退出 → 终端恢复干净 ✓