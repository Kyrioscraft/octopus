# AskPanel 按钮重新设计计划

## 现状问题
当前按钮使用 `type="primary"` + inline `style={{ background: "var(--gray-900)", borderColor: "var(--gray-900)" }}` 的方式，导致：
- antd 的 `type="primary"` 自带 hover/active 效果（基于 `colorPrimary` 绿色），与 inline style 硬覆盖冲突
- 拒绝按钮只是简单设了 `color` 和 `borderColor`，没有 hover 态
- 整体缺乏过渡动画，看着生硬

## 解决方案
遵循代码库现有模式（InputBar 的发送按钮即为此模式）：
- **弃用 `type="primary"`**，改用 `type="default"` 作为基座
- **用 inline style 控制所有视觉**（base + hover + active，通过 `onMouseEnter/Leave`）
- **统一过渡动画** `transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1)`

## 具体样式设计

### 1. 主操作按钮（提交 / 下一题 / 批准）
```
Base:
  background: var(--gray-900)
  color: var(--gray-0)
  border: 1px solid var(--gray-900)
  boxShadow: none
  
Hover:
  background: var(--gray-700)  → 微亮，不呆板
  border: 1px solid var(--gray-700)
  boxShadow: 0 1px 2px var(--shadow-1)  → 微微浮起
  
Active (mousedown):
  background: var(--gray-600)  → 更深，有按下感
  
Disabled:
  opacity + antd 的 disabled 默认行为
```

### 2. 拒绝按钮
```
Base:
  background: transparent
  color: var(--color-error-500)
  border: 1px solid var(--color-error-200)  → 淡红边框，不刺眼
  
Hover:
  background: var(--color-error-50)  → 极淡红底
  borderColor: var(--color-error-500)  → 边框变深，提示可点击
  
Active:
  background: var(--color-error-100)
```

### 3. 本次会话都批准
保持 `type="text"` + 简单 inline style，无需 hover handler。

## 实现方式

在 AskPanel.tsx 中：
1. 所有按钮去掉 `type="primary"`
2. 每个按钮用 `useRef` 获取 DOM 引用，在 `onMouseEnter/Leave/MouseDown/MouseUp` 中直接操作 `ref.current.style`
3. 或更简洁：用 state 管理 hover/press 态，React 响应式更新 inline style

推荐用 **state 管理**（更 React 化）：
```tsx
const [hovered, setHovered] = useState<Record<string, boolean>>({});
// 按钮上: 
style={baseStyle, ...(hovered['submit'] ? hoverStyle : {}), ...}
onMouseEnter={() => setHovered(p => ({...p, submit: true}))}
onMouseLeave={() => setHovered(p => ({...p, submit: false}))}
```

## 改动文件
仅 `web/src/components/chat/input/AskPanel.tsx`
- AskPanel 组件的 footer 按钮区
- ToolApprovalActions 组件

## 验证
- `cd web && npm run lint` 通过