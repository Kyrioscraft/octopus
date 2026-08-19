# 目录重组

移动文件到分类子目录，更新全部 import 路径。

## 移动
- `core/`: tui-adapter, stream-events, tool-tracker, tool-utils
- `client/`: client, server-manager, auth-store, sessions  
- `terminal/`: config-ui, theme, use-frame, terminal, terminal-escape, clipboard
- `utils/`: formatting, logging, file-ops, offload, plain-text
- `input/`: input-parser, editor

## 更新 import
批量替换所有引用这些文件的 import 路径，适配新的目录层级。每个文件改动约 2-5 个 import 行。

## 验证
`cd tui && npm run build`