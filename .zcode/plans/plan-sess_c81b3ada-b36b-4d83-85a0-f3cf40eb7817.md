# 修复子智能体流式输出重复（源头修复，不用去重兜底）

## 已确认事实
- 重复形态是 token 级双流交错（`II'll'll explore explore`），说明每个 token chunk 被上报两次。
- 仓库链路（engine → server NDJSON → tentacle → web 累加器）均为单次 delta 单次追加，无双重累加。
- 服务端 `agent.stream(..., {streamMode:["messages"]})`（chat.service.ts:538）；LangGraph `StreamMessagesHandler` 的 token 路径本身不去重；deepagents `task` 工具 invoke 子图时继承父 config 并打 `lc_agent_name`，子图自身 `.withConfig` 也打同名 metadata —— 双上报来自 LangGraph/deepagents 层，而非本仓库代码 bug。

## 阶段 1：插桩实锤（用户已同意跑）
在 `packages/core/src/engine.ts` 的 `wrapAgentStream` 循环入口加临时日志：打印每个原始 chunk 的 `msg.id`、`ns`、`lc_agent_name`、text 前 40 字符、对象引用是否相同。构建 core，启动 server，发起一次触发 Explore 子 agent 的请求，分析日志区分：
- 相邻两条完全相同（同 id 同文本）→ 双 handler 监听；
- 两条 ns 形态不同 → 双路径冒泡。

## 阶段 2：源头修复（按结论二选一）
- **情形 A（双 handler）**：给重复那一层的子 agent config 打 LangGraph 认可的 `nostream` tag（`handleChatModelStart` 会跳过带 `langsmith:nostream`/`nostream` tag 的 run），在 core 组装 subagent spec / task 调用处实现。
- **情形 B（双路径冒泡）**：在 `engine.ts` 过滤逻辑中按 ns 形态结构性只保留一条合法路径（如仅保留 `tools:<run-id>|model_request:` 前缀的子 agent chunk），非内容去重，不误伤合法 token。

## 验证
1. `cd packages/core && npx tsc --noEmit`；
2. 启动 server + web，触发 Explore 子 agent，确认实时输出无重复、主 agent 输出正常、subagent_started/finished 生命周期事件正常；
3. 移除阶段 1 插桩代码，再次确认编译通过。