## 按 ZCode 语义修正 preset 权限规则

### 改动文件
**`packages/core/src/agents/builtin.ts`**（唯一核心改动）：

1. 提取共享的只读命令白名单规则（confirm 与 auto 复用）：
```ts
const READONLY_EXECUTE = {
  "rg *": "allow", "grep *": "allow", "find *": "allow", "ls*": "allow",
  "dir*": "allow", "cat *": "allow", "head *": "allow", "tail *": "allow",
  "git status*": "allow", "git diff*": "allow", "git log*": "allow", "git show*": "allow",
  "*": "ask",
};
```

2. **confirm** preset：`permissionConfig` 改为
   `{ "*": "ask", execute: READONLY_EXECUTE, shell_file_write: "ask" }`
   → 只读命令免审、其余审批、shell 写命令审批。

3. **auto** preset：改为
   `{ "*": "allow", execute: READONLY_EXECUTE, shell_file_write: "ask" }`
   → 编辑类工具自动放行，Bash 逐次审批（accept-edits 语义），shell 写命令审批（原为 deny 硬拦 → 改 ask）。

4. plan / full 不变（已符合 ZCode：plan=只读免审+写禁止，full=全放行）。

### 验证
- core `tsc --noEmit` + build；
- node 脚本验证行为矩阵：

| 命令 | plan | confirm | auto | full |
|---|---|---|---|---|
| `rg foo` / `ls`（只读） | 免审 | **免审** | **免审** | 免审 |
| `npm test`（普通） | 免审 | 审批 | **审批** | 免审 |
| `sed -i …`（shell 写） | 硬拦 | 审批 | **审批**（原硬拦） | 免审 |
| write_file/edit_file | 工具剥离 | 审批 | 自动放行 | 自动放行 |

### 文档
AGENT_MIGRATION_PLAN.md 实施记录中的行为矩阵更新为 ZCode 语义版本。