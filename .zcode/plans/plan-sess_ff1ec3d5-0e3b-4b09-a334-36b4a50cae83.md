## 优化目标
两处 UI 精致化,均限定在 `web/` 包内,纯前端改动:
1. **模型管理 - 远程模型列表**(`ModelSettingsSection.tsx` 的 `ModelsModal`):当前是手写的扁平 flex 列表,无表头、无加载骨架、空状态简陋、搜索只匹配 `id`。
2. **对话输入框 - 访问模式选择器**(`Chat.tsx`):antd 默认从 `colorPrimary: #389e0d` 派生的浅绿选中背景(`#d9f7be` 左右)与输入栏整体灰白极简风格不搭。

---

## 方案 A:模式选择 — 低调中性灰风格(全局收敛)

**文件:`web/src/App.tsx`**(第 14-25 行的 `ConfigProvider` theme)

在 `theme` 中新增 `components.Select` 配置,把选中项/悬停项改为低饱和度中性灰,与输入栏的灰白风格统一:

```tsx
theme={{
  token: { colorPrimary: "#389e0d", borderRadius: 8, fontFamily: "..." },
  algorithm: antdTheme.defaultAlgorithm,
  components: {
    Select: {
      optionSelectedBg: "var(--gray-100)",      // 选中项背景 → #eff2f2(柔和浅灰)
      optionSelectedColor: "var(--gray-1000)",   // 选中项文字保持深色
      optionSelectedFontWeight: 600,             // 靠字重区分选中
      optionActiveBg: "var(--gray-50)",          // 悬停项 → #f2f4f4
    },
  },
}}
```

> **为什么放 App.tsx 而非 Chat.tsx**:这是全局 token,所有 Select(模型选择器、设置页、扩展页等)都会一致生效,避免 Chat 里单独包 `ConfigProvider` 造成嵌套主题分裂。改动 1 处,风险最小。
>
> 注:antd token 不支持 CSS `var()` 函数,需直接填十六进制值(`#eff2f2` / `#151616` / `#f2f4f4`),我会对照 theme.css 的对应变量硬编码并加注释说明对应关系。

**可选增强(Chat.tsx 第 573-584 行)**:给访问模式 Select 的选中项加一个极轻的视觉锚点——通过 `labelInValue` + 自定义 `tagRender` 不合适(会改变交互),改为保持现有 Select 结构不变,仅靠全局 token 收敛即可。**不改动 Chat.tsx 的模式选择 JSX**,避免引入额外风险。

---

## 方案 B:远程模型列表 — 全面重做

**文件:`web/src/components/settings/SettingsSidebar.tsx` → 实际是 `web/src/components/settings/ModelSettingsSection.tsx`**(第 480-552 行 + 辅助函数 + Modal 容器)

### B1. 加载骨架(当前 `remoteLoading` 时远程区完全不渲染)
- `fetchRemote` 期间(`remoteLoading === true && remoteModels === null`),在"已启用模型"区下方渲染一个占位区块:标题"远端候选模型"+ 5 行 `Skeleton` 占位(antd 的 `<Skeleton.Input active size="small" />` 组合),给用户即时反馈。

### B2. 远程列表卡片化 + 统一表头
把第 508-549 行的扁平 flex 列重做为带圆角边框的卡片容器(与上方"已启用模型"表风格一致):
- 容器:`border: 1px solid var(--gray-150)`, `borderRadius: 8`, `overflow: hidden`
- 表头行(grid 布局):`模型 | 类型 | 上下文 | 操作`,背景 `var(--gray-50)`,字号 11、字重 600、大写、字间距(复用现有"已启用模型"表头样式,第 417-430 行)
- 数据行:grid 布局对齐表头,`borderTop: 1px solid var(--gray-100)`,去掉当前行内的 `borderTop`(避免重复分隔)

### B3. 行内视觉精致化
- `displayName` 主标题(字重 500,`var(--gray-1000)`),`id` 副标题改为更小的等宽灰色标签(字号 11,`var(--gray-400)`),与主名分行或保持内联但弱化
- 保留 `TypeTag`(已精致),`formatContext` 上下文长度右对齐
- hover:用纯 CSS 类替代当前 `onMouseEnter/onLeave` 直接改 style 的反模式(新增一个 `.remote-row` 类到现有内联方案中——因项目无 CSS module,我会在 `ModelsModal` 外层加一个局部 `<style>` 注入,或沿用文件已有的内联 + transition 模式但简化)。**权衡**:项目全用内联样式无 CSS 文件,为保持一致,hover 仍用内联 `onMouseEnter/Leave` 但加 `transition: background 0.15s`,与"已启用模型"表行(第 442 行已有 transition)保持一致风格。

### B4. 虚拟滚动(大列表性能)
远程列表改用 antd `<List>` 组件并开启 `virtual`:
```tsx
<List
  virtual
  split={false}
  dataSource={filteredRemote}
  renderItem={(m) => ( /* 同 B3 的行内容 */ )}
  style={{ maxHeight: 360, overflowY: "auto" }}
/>
```
- 对 OpenRouter 等返回数百模型的供应商,避免一次性渲染全部 DOM
- `maxHeight: 360` + 内部滚动,Modal 不再无限增长(修复当前 Modal 超出视口只能靠页面滚动的问题)
- `split={false}` 关闭 antd 默认分割线(我们用自定义 borderTop)

### B5. 空状态升级
第 498-506 行的纯文本空状态,改用已导入的 `<Empty>` 组件(主供应商列表第 152 行已用,保持一致),带插图 + 描述文本。

### B6. 搜索匹配修复(UX bug)
第 351 行 `filteredRemote` 当前只匹配 `m.id`,改为同时匹配 `id` 和 `displayName`:
```tsx
return remoteModels.filter((m) => !q
  || m.id.toLowerCase().includes(q)
  || m.displayName.toLowerCase().includes(q));
```

### B7. Modal 容器高度收敛
第 355-361 行 `ModelsModal` 的 `<Modal>` 加 `styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}`,防止列表很长时 Modal 撑爆视口。

---

## 涉及文件清单
| 文件 | 改动 |
|---|---|
| `web/src/App.tsx` | `ConfigProvider.theme` 新增 `components.Select` token(方案 A) |
| `web/src/components/settings/ModelSettingsSection.tsx` | `ModelsModal` 远程列表区重做 + 加载骨架 + 空状态 + 搜索修复 + Modal 高度(方案 B1-B7) |

**不改动**:Chat.tsx(模式选择 JSX 保持不变,靠全局 token 生效)、tentacle、server、core。无新增依赖(全部用已导入的 antd 组件:`List`、`Skeleton`、`Empty`)。

## 验证
- `cd web && npm run lint`(即 `tsc --noEmit`)确认无类型错误
- 手动验证:打开模型管理 → 点"获取远程模型",观察骨架→列表渲染、搜索、虚拟滚动、空状态;打开对话页点访问模式,观察下拉选中/悬停背景为中性灰而非刺眼浅绿