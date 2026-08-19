# 优化 octopus 搜索效率（参照 opencode 实现）

## 根因
1. `execute` 底层是 deepagents SDK `LocalShellBackend.execute()` → `spawn(command, {shell: true})`，Windows 上 = cmd.exe；而提示词声称 "Git Bash on Windows"，模型在错误预期下退化成 `cmd /c findstr`。
2. 提示词强制绝对路径，模型手工拼接绝对路径时易错（如 `...\dm-copilot\dm-copilot\backend\...` 重复根目录），rg 报路径不存在后又连续盲试。
3. 模型裸调 `rg` 依赖 PATH；octopus 自带捆绑 ripgrep 但 shell 的 env 里没有它所在目录，PATH 无 rg 时命令直接失败。

## 改动

### 1. 新增 `packages/core/src/shell.ts` — shell 探测（移植 opencode 逻辑）
- `resolveBash()`: env 变量 `OCTOPUS_GIT_BASH_PATH` → `which("git")` 推导 `<git>\..\..\bin\bash.exe` → `which("bash")` → 常见安装路径（`C:\Program Files\Git\bin\bash.exe` 等）→ 失败返回 undefined。结果模块级缓存。仅 `win32` 时探测。

### 2. `packages/core/src/agent.ts` — BashShellBackend 子类
`class BashShellBackend extends LocalShellBackend`，覆写 `execute(command)`：
- win32 且探测到 bash：`spawn(bashPath, ["-c", command], { cwd: this.cwd, env })`（env 含捆绑 rg 目录注入 PATH，见第 5 点）。
- 否则回退 `spawn(command, { shell: true, cwd, env })`（与 SDK 原实现一致）。
- 保留原实现的 timeout、stdout/stderr 聚合、`[stderr]` 前缀、truncation 逻辑（约 60 行，参照 SDK dist 源码）。
- `makeGraph` 中（agent.ts:709-713）用 `BashShellBackend` 替换 `new LocalShellBackend(...)`。

### 3. `packages/core/src/middleware/filesystem_policy_middleware.ts` `_shellGuidance()` — 按实际 shell 分支 + 相对路径约束
运行时调用 `resolveBash()`：
- **有 bash**：如实说明命令通过 Git Bash 执行，可用 `grep -rn "pattern" src | head -20`、管道等 Unix 语法；给出高效搜索示例。
- **无 bash**：如实说明是 cmd.exe，给正确的 `findstr /s /i /n "pattern" src\*.ts` 示例。
- 通用新增两条：
  - **搜索命令（rg/grep/findstr）的路径参数一律用相对路径**（cwd 已是工作区根目录），禁止手工拼接绝对路径。
  - **命令报“路径不存在”时，先 `ls` 确认目录结构再重试**，不要连续盲试。
- 删除 "Git Bash on Windows" 的错误声明和 "Prefer absolute paths"。

### 4. `packages/core/src/prompts.ts:27` — 去掉绝对路径强制
改为：shell 命令中的路径一律使用相对路径（cwd 为工作区根目录，见 system-reminder）；文件编辑工具（read/edit/write）仍用从工作目录构造的绝对路径。

### 5. 捆绑 rg 注入 PATH
在 agent.ts 构建 backend 时，把捆绑 ripgrep 二进制所在目录（复用 `extensions/ripgrep/src/ripgrep.ts` 的解析逻辑，提取为可从 core 引用的工具函数或复制其路径解析）加入传给 backend 的 `env.PATH`（prepend，保留原 PATH）。这样模型裸调 `rg` 和 SDK `grep` 工具的 `spawn("rg")` 都能命中捆绑版。

## 验证
- `cd packages/core && tsc --noEmit`
- 起 server 实测：让 agent 搜索符号，确认命令变为 `rg`/`grep` 相对路径形式，无 `cmd /c findstr`、无重复根目录路径，搜索次数明显减少。

## 不做
恢复 grep_search 专用工具给主 Agent、Explore 子 Agent 工具集调整（可后续另行处理）。
