## 目标
修复 DirBrowserModal 的"返回上一级"按钮 bug：进入子目录后按钮始终 disabled、点击无效。

## 根因（已用 node 验证）
`crumbs` 计算在 Windows 盘符根路径下前缀匹配失败。

**`DirBrowserModal.tsx:62`**：
```js
const root = data.roots.find((r) =>
  data.current === r ||
  data.current.startsWith(r + "\\") ||   // ← BUG
  data.current.startsWith(r + "/")
);
```

Windows 上 `roots` 元素是 `"C:\"`（本身含尾随反斜杠，来自 `workspace_paths.ts:74` 的 `${letter}:\\`）。当 `current = "C:\Users\kai"`：
- `r + "\\"` = `"C:\\"`（两个反斜杠）
- `current` 开头是 `"C:\U"`（单反斜杠）
- `startsWith("C:\\")` → **false** → `root` 匹配失败

`root` 为 undefined → `base = current` → `rel = ""` → `segs = []` → **`crumbs.length === 1`**（恒为 1）→ 第 119 行 `disabled={... || crumbs.length <= 1}` **永远 true**，按钮点不动。

（只有 `current === "C:\"` 恰好等于 root 时才匹配，走的是 `=== r` 分支。）

## 修复方案（单一改动文件：`web/src/components/workspace/DirBrowserModal.tsx`）

### 改动 1：新增一个稳健的"路径是否在 root 下/等于 root"判断函数
在组件内（`crumbs` 之前）加一个辅助函数 `findContainingRoot(current, roots)`：
- 把每个 root 的**尾随分隔符剥掉**后再做前缀比较，避免 `r + "\\"` 双反斜杠陷阱
- 判断 `current === rootNorm` 或 `current` 以 `rootNorm + 分隔符` 开头（分隔符 `\` 或 `/` 都接受）
- 返回匹配到的原始 root（或 undefined）

这样 `C:\Users\kai` 对于 root `C:\`：`rootNorm = "C:"`，检查 `current === "C:"`(否) 或 `current.startsWith("C:" + "\\")`(是) → **匹配成功**。

### 改动 2：重写 `crumbs` 使用新判断函数（第 59-73 行）
- 用 `findContainingRoot` 取得 `root`（替代脆弱的 `find` + `startsWith(r+"\\")`）
- 其余逻辑（按分隔符切段、累积路径）保持，但累积时也用规范化分隔符
- `base` 取 root（剥尾随分隔符后的形式）以保证 `rel` 切片正确

### 改动 3：把禁用判断改为不依赖 crumbs（第 119 行）
当前 `disabled={!data || crumbs.length <= 1}` 依赖 crumbs 长度，是脆弱的间接判断。改为**直接判断"当前是否已在顶层 root"**：
```js
disabled={!data || isAtRoot(data.current, data.roots)}
```
新增 `isAtRoot(current, roots)`：用 `findContainingRoot` 判断 current 是否恰好等于某个 root（即在顶层、无父级可返回）。这与 `goUp` 的语义完全一致（`goUp` 在 root 时返回不做），单一真相源，避免 crumbs 显示与禁用状态脱节。

### 改动 4：`goUp` 也用新判断（第 80-90 行，防御性）
当前 `goUp` 用 `parent.startsWith(r + "\\")`，同样的双反斜杠陷阱——虽然在按钮 disabled 时不会被触发，但一旦将来从别处调用就会出问题。把第 88 行的 `within` 判断也换成 `findContainingRoot(parent, roots)`，与改动 3 保持一致。

## 不变项
- 后端 API、`listHostDirs`、`browsableRoots` 全部不改（返回的路径格式是正确的，bug 纯在前端解析）
- `load` / `enterDir` / `confirm` 逻辑不改
- props 接口、Sidebar 调用方不改
- 面包屑的显示行为（点击各层级跳转）不变，只是计算更准确
- 不引入新依赖

## 验证
1. **node 单元验证**：用 `\x5c` 构造真实反斜杠路径，跑修复后的 `findContainingRoot` / `isAtRoot`，确认：
   - `current="C:\Users\kai"`, roots=`["C:\","D:\"]` → root 匹配 `C:\`，`isAtRoot`=false（按钮可点）
   - `current="C:\"` → `isAtRoot`=true（按钮 disabled）
   - `current="C:\Users"` → crumbs 有 2 项（C: + Users）
2. `cd web && npx tsc --noEmit` 类型检查通过
3. 手动：打开选择器 → 双击进子目录 → "上一级"按钮变可点 → 点击返回父目录成功；在盘符根时按钮灰显