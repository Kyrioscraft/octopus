# 重命名 OctopusEvent → StreamEvent

1. `tentacle/src/types.ts`:union 定义改名 `StreamEvent`(真名),`OctopusEventType` → `StreamEventType`,删除旧 alias 块,合并注释
2. `tentacle/src/index.ts`:导出 `StreamEvent`/`StreamEventType`,移除 `OctopusEvent`
3. `web/src/components/chat/turn/TurnEventAccumulator.ts`:import 与签名跟随改名
4. 全局 grep 确认 `OctopusEvent` 无残留;core `AgentEvent`/server `WireEvent` 不动
5. 验证:tentacle build、web tsc + vite build