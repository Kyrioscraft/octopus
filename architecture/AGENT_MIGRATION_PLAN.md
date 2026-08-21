# 智能体化架构：Agent Preset + Permission Ruleset

> **状态：已实施完成（2026-08）。** 本文仅保留架构决策与规则语义，
> 作为 `packages/core/src/agents/` 与 `packages/core/src/permission/` 的设计参考。
> 调研基准：sst/opencode。

---

## 核心设计

**模式 = 智能体配置**。没有独立的"模式"概念，工具集、审批策略、提示词
全部收敛为 agent preset 的数据字段（`packages/core/src/agents/builtin.ts`）：

```ts
export interface AgentPreset {
  name: string;                    // "plan" | "confirm" | "auto" | "full" | 自定义
  label: string;
  description: string;
  mode: "primary" | "subagent";
  promptBlock: string;             // 拼接进系统提示词
  disabledTools: string[];         // 静态剥离，LLM 不可见
  permissionConfig: PermissionConfig;  // 声明式规则
  permission: PermissionRuleset;       // 编译结果
  interruptOnOverride: Record<string, boolean>;  // 由规则派生，非字面量
  bypassFileEditGuard: boolean;
  submitPlan: boolean;
}
```

## Permission Ruleset（`packages/core/src/permission/`）

opencode 式三级权限，替代布尔 `interruptOn`：

- **规则**：`Rule { permission, pattern, action }`，action 为
  `allow / ask / deny`，pattern 为 glob（`*` `**` `?`，路径归一化、
  win32 大小写不敏感）。
- **求值**：`findLast` 匹配——后面的规则覆盖前面，未命中默认 `ask`。
  因此 catch-all 在前、具体例外在后：`{ "*": "ask", "rg *": "allow" }`。
- **双层生效**：
  - 静态：`deny` 且 pattern=`*` 的工具直接从 LLM 工具列表移除；
  - 动态：其余工具执行时求值 → allow 放行 / deny 拦截 / ask 挂起等
    用户审批（once / always / reject）。

配置形式：

```ts
{
  edit: { "*": "deny", "docs/**/*.md": "allow" },
  bash: { "*": "ask", "git *": "allow" },
  webfetch: "ask",
}
```

### always 写回（thread 级规则）

HITL "always" 审批持久化为 thread 级 ruleset（threads 表 `permission`
JSON 列），后续审批点自动生效；/agent 与 resume 的 interruptOn override
均合并 thread 规则（later wins）。**切换 agent 时清空**——always 批准
属于其授权时的 agent 上下文。前端 `sessionAllowlist` 仅作 UI 即时性
fast path，服务端规则为权威。

## 消息级 Agent 绑定

agent 绑定在消息级而非 session 级：每条 user 消息在
`messages.extra_metadata.agent` 记录 agent；未指定时继承
`lastUser.agent`，再回退 thread 缓存值，默认 `"confirm"`。切换 agent
不新建会话、不清历史。

**plan→build 切换**：`submit_plan` 工具触发审批门；批准后注入 synthetic
user 消息（"计划已批准，开始执行…"，agent=confirm），graph 按新 agent 重建。

## 四内置 Preset 的权限矩阵

按 ZCode 四档语义（confirm 只对非只读命令审批；auto 是"编辑放行、
Bash 仍审批"）：

| 命令 | plan | confirm (default) | auto (accept-edits) | full |
|---|---|---|---|---|
| 只读 Bash（rg/ls/git diff…） | 免审 | 免审 | 免审 | 免审 |
| 普通 Bash（npm test/rm…） | 免审 | 审批 | 审批 | 免审 |
| shell 写文件（sed -i/echo >…） | 硬拦 | 审批 | 硬拦（重定向到 edit_file） | 免审 |
| write_file / edit_file | 工具剥离 | 审批 | 自动放行 | 自动放行 |

实现要点：

- `READONLY_EXECUTE` 白名单（rg/grep/find/ls/cat/git 只读子命令等），
  confirm 与 auto 共用；
- `shell_file_write` 独立规则通道：`FileEditGuardMiddleware` 接受
  `fileWriteRuleset`，对 shell 文件写命令求值——deny 硬拦（重定向到
  edit_file/write_file）、ask 转为 HITL 审批（中间态）、allow 放行；
- interrupt payload 嵌入匹配到的规则（`matched permission rule
  "execute: *" → ask`），AskPanel 渲染为"触发规则"chip。

## 遗留扩展点

- 用户自定义 primary 智能体（加入 Tab 循环 / 下拉，复用
  `resolveToolWhitelist`），`BUILTIN_AGENTS` 扩展点已就绪。
