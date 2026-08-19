## 问题根因

Agent 在探索时反复调用 `ls`/`grep` 并穿插 thinking，根因是 **deepagents SDK 的 `FilesystemMiddleware` 在每次 model call 时，把 SDK 自带的 `FILESYSTEM_SYSTEM_PROMPT` 和工具描述追加到 system message 的最末尾**，覆盖了 Octopus 自己的 prompt 意图：

- SDK 的 `LS_TOOL_DESCRIPTION` 明确写着："You should almost ALWAYS use this tool before using the read_file or edit_file tools" —— 这与 Octopus `prompts.ts:86-110` 的 "prefer grep/glob, ls at most once" 直接冲突。
- 因为 SDK 的指令在 system message 中**位置靠后**（recency bias），模型优先遵循 SDK 的指令。
- `createDeepAgent` **不暴露** `customToolDescriptions` / `filesystemOptions` 参数（确认于 SDK 源码 line 5810，只传了 `backend` 和 `permissions`），无法通过配置层关闭。

## 方案：自定义 `wrapModelCall` 中间件

新增中间件 `FilesystemPolicyMiddleware`，放在 `core/src/middleware/filesystem_policy_middleware.ts`。它在 FS middleware **之后**运行（确认：SDK 源码 line 5824-5832，`...customMiddleware` 在 `fsMiddleware` 之后），因此能在工具描述和 system message 到达模型前最后一刻重写它们。

机制完全沿用 FS middleware 自己用的 read-filter-replace 模式（`langsmith-wdF8zG42.js:2000-2017` 的 `let tools = request.tools; tools = tools.filter(...); handler({...request, tools})`）。

### 改动 1：新建 `core/src/middleware/filesystem_policy_middleware.ts`

```typescript
// Enforces Octopus's filesystem tool policy:
// prefer grep/glob over ls, paginate read_file, etc.
// Runs after SDK's FilesystemMiddleware to override its defaults.

// 覆盖的工具描述（与 Octopus prompts.ts 的 "prefer grep/glob" 对齐）
const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  ls: "Use sparingly. Prefer `grep`/`glob` for codebase exploration. " +
      "At most once at the start to get a rough layout; never use it " +
      "to explore level-by-level.",
  list_directory: "/* same as ls */",
  read_file: "Prefer `grep` to locate symbols first, then read targeted " +
             "sections. Use `offset`/`limit` for large files (>500 lines).",
};

export class FilesystemPolicyMiddleware {
  wrapModelCall = (request, handler) => {
    // 1. 重写工具描述
    const tools = request.tools.map((t) => {
      const override = TOOL_DESCRIPTION_OVERRIDES[t.name];
      if (!override) return t;
      return t.clone({ description: override });  // BaseTool.clone 安全，不改实现
    });

    // 2. 剥离 FS middleware 追加到 systemMessage 末尾的 FILESYSTEM_SYSTEM_PROMPT
    //    （它包含 "almost always ls before read_file" 等与 Octopus 冲突的指引）
    let systemMessage = request.systemMessage;
    const content = systemMessage.content;
    if (typeof content === "string") {
      const cleaned = stripFilesystemSystemPrompt(content);
      if (cleaned !== content) {
        systemMessage = new SystemMessage({ content: cleaned });
      }
    }

    return handler({ ...request, tools, systemMessage });
  };
}
```

**`stripFilesystemSystemPrompt`** 的实现思路：FS middleware 用 `systemMessage.concat(filesystemPrompt)` 拼接（SDK line 2009 附近）。我们需要识别并移除这一段。由于 `FILESYSTEM_SYSTEM_PROMPT` 有明确的起始特征文本（如 "# Filesystem" 或类似 heading），用 `indexOf` 定位后截断即可。具体分隔符需要在实现时 dump 一次实际 system message 确认（或直接 import SDK 导出的常量，如果有的话）。

### 改动 2：在 `core/src/agent.ts` 注册中间件

在 line 590 附近（`middleware.push(...)` 区域），加入：
```typescript
middleware.push(new FilesystemPolicyMiddleware());
```
它必须在 `createDeepAgent` 调用前 push，最终通过 `createDeepAgent({ middleware })` 传入。由于 SDK 把 `customMiddleware` 放在 `fsMiddleware` 之后（line 5832），顺序天然正确，无需额外处理。

### 改动 3：类型处理

中间件的 `request` 参数类型用宽松的内联类型（沿用 `LocalContextMiddleware` 的风格，只声明用到的字段 `tools`、`systemMessage`），避免引入对 langchain 内部 `ModelRequest` 类型的硬依赖。需要 import `SystemMessage` from `@langchain/core/messages`。

## 为什么这个方案可行

1. **顺序正确**：SDK 源码确认 `customMiddleware` 在 `fsMiddleware` 之后，我们的 `wrapModelCall` 最后运行，能覆盖 FS middleware 写入的描述。
2. **机制有先例**：FS middleware 自己就是这么改 `request.tools` 的（filter execute tool）。我们只是 map 改 description。
3. **`clone({ description })` 安全**：只改元数据，不动工具实现，不影响 provider 的工具缓存/并行逻辑。
4. **不影响功能**：工具行为完全不变，只是让模型看到与 Octopus 系统提示一致的描述。

## 不做的事

- 不替换 `createFilesystemMiddleware` 本身（要重造 SDK 内部组装逻辑，风险大）
- 不给 Explore subagent 单独设 `recursionLimit`（本次问题根因是 prompt 冲突，不是步数；先验证描述覆盖效果）
- 不删除 `marked`/`remend`（与本次无关）

## 验证

1. `cd core && npm run lint`（`tsc --noEmit`）
2. `cd core && npm run build`
3. 启动 server，问一个需要探索代码库的问题（如 "find where makeGraph is defined and how it's called"）
4. 观察 agent 是否还反复 ls —— 预期：直接 grep/glob → read_file 命中，不再逐层 ls
5. 确认 FS 工具仍正常工作（read_file/write_file/edit_file 不受影响）