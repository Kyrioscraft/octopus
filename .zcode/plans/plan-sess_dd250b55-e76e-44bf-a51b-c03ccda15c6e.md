# 重新设计 Octopus 图标 + 空状态（几何极简线条 + 绿色渐变）

## 设计理念

将卡通章鱼重塑为**几何极简线条 + 绿色渐变**的现代品牌图形：
- **抽象化章鱼**：圆润头部轮廓 + 几条优雅弧线触手，统一描边宽度，对称几何构图
- **绿色渐变**：用 SVG `<linearGradient>`（`#237804` 深绿 → `#4caf50` 浅绿），增加立体高级感
- **去卡通化**：移除呆萌大白眼，改为极简点状眼或纯抽象轮廓
- **同源统一**：favicon 与 logo 使用同一 viewBox（100×100），空状态复用同一图形放大展示

## 改动清单（4 个文件）

### 1. `web/public/favicon.svg`（重写）
- 新设计：几何极简章鱼，viewBox `0 0 100 100`
- 头部用流畅的弧线轮廓（非实心圆），触手用统一描边宽度的优雅贝塞尔曲线
- 填充/描边应用绿色渐变 `<linearGradient id="brandGrad">`
- 确保在浏览器标签页 16×16 等小尺寸下清晰可辨（简化细节、加粗关键线条）

### 2. `web/public/octopus-logo.svg`（重写）
- 与 favicon 同源设计，viewBox `0 0 100 100`，细节更丰富
- 同样使用绿色渐变
- 确保 28×28（Sidebar 渲染尺寸）下精致清晰

### 3. `web/src/pages/Chat.tsx`（修改空状态，约第 386 行）
- **替换**：`<RobotOutlined style={{ fontSize: 48, color: "var(--main-500)", marginBottom: 16 }} />`
- **改为**：`<img src="/octopus-logo.svg" alt="Octopus" style={{ width: 72, height: 72, marginBottom: 20, filter: "drop-shadow(0 4px 12px rgba(35,120,4,0.12))" }} />`
  - 放大到 72px（比原 48px 图标更突出，但不过分）
  - 加柔和绿色投影增强层次感
- 移除 `RobotOutlined` 的导入（若该文件无其他引用），保持导入整洁
- 保留现有的 `fadeInUp` 动画和整体布局不变

### 4. 验证（不改动，仅检查）
- `index.html` 第 7 行 favicon 引用路径不变（`/favicon.svg`），无需改动
- `Sidebar.tsx` 第 117-121 行 logo 引用路径不变（`/octopus-logo.svg`），无需改动

## 设计细节规范

**SVG 渐变定义**（favicon 与 logo 共用）：
```svg
<defs>
  <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#237804"/>
    <stop offset="100%" stop-color="#52c41a"/>
  </linearGradient>
</defs>
```

**视觉特征**：
- 纯描边/块面化的几何章鱼轮廓，去除卡通大眼
- 对称构图，触手弧度优雅流畅
- 绿色单色渐变，与项目 `--main-color` 体系一致
- 无外部依赖、无 filter（投影在 React 侧用 CSS `drop-shadow` 实现）

## 不在范围内

- 不更改 `theme.css` 的 CSS 变量（保持现有绿色体系）
- 不更改 `index.html` / `Sidebar.tsx` 的引用路径
- 不增加 PNG/PWA 图标（保持纯 SVG 架构）
- 不改动空状态的问候语、示例问题、输入框等其他元素

## 验证方式

- 运行 `cd web && npx tsc --noEmit` 确认 TypeScript 无类型错误（移除 RobotOutlined 导入后）
- 视觉检查由你在浏览器中确认（dev server 或 build 后）
