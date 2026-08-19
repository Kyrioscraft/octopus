## FileEditToolView diff 重构方案

### 格式
```
⏺ edit_file  src/foo.ts  +5 -2   ← amber 左边框
  - const old = 1;                 ← 红色，⎿ gutter 对齐
  - const old2 = 2;                
  + const new = 1;                 ← 绿色
  + const new2 = 2;
  … 8 more lines                   ← 超出 15 行截断
  ✓ done                           ← 状态行
```

### 数据来源
- `message.metadata.toolArgs` → `old_string`/`new_string`/`file_path`/`content`
- `message.metadata.diffStats` → `{ added, removed }`

### 实现
`messages.tsx` 中重写 `FileEditToolView`：
1. 从 `toolArgs.old_string`/`new_string`（edit_file）或 `toolArgs.content`（write_file）提取 diff 行
2. 带 `+`/`-` 前缀 + 颜色渲染，最多 15 行
3. `⎿` gutter 固定宽度对齐

### 改动文件
仅 `messages.tsx` — 重写 `FileEditToolView`（从当前仅 header+status 恢复为完整 diff 渲染）