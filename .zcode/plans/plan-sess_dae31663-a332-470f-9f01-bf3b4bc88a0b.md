# 修复切换历史后出现的多个 Timer / 计时重置

## 根因
1. **多个 Timer**:运行中切回时,`load()` 只删除了 history 的**最后一条** assistant 行;但一轮 turn 在库里是**多条** assistant 行(且 normalizeHistory 会把它们合并成一个带定格 Timer 的 turn 气泡)——前面几行合并出的"已完成"气泡(带停止的 Timer)留在上面,reattach 又追加新的 streaming 气泡(第二个 Timer)。若多次切换,每次 reattach 前的 load 都重复此模式。
2. **新 Timer 从 0 重新计时**:reattach 气泡的 `startedAtMs: Date.now()`,而服务端 run 早已开始;服务端 `/events` 没有告知 run 的真实起始时间。

## 修复

### 1. `web/hooks/useChat.ts` — load()
running 时删除**整个末尾 turn**(从最后一条 user 消息之后的所有行),而不是一行:
```ts
if (running) {
  const lastUserIdx = rows.map(r=>r.role).lastIndexOf("user");
  rows = lastUserIdx >= 0 ? rows.slice(0, lastUserIdx + 1) : [];
}
```
(消息只在 run 结束才落库,运行中的 turn 在 history 里要么没有、要么是 resume 前已落库的半轮——统一删掉由重放流重建,保证只有一个 turn 气泡、一个 Timer。)

### 2. `server/routes/chat.ts` — /events 回放流头部
回放前先 push 一个元数据 chunk:`{ status: "init", meta: { thread_id, run_started_at: run.startedAt } }`,让前端校准计时起点。

### 3. `web/hooks/useChat.ts` — reattach
- 创建气泡时不再用 `Date.now()`:初始为 undefined,在 doStream 的 `init` 分支若 `ev.meta?.run_started_at` 存在且当前最后气泡是 streaming,则写入 `startedAtMs = run_started_at`(计时从服务端真实起点开始,切回后显示正确已耗时)。

## 验证
- tsc 各包;浏览器:发消息 → 运行中切走 → 切回 → 只有一个 Timer 且时长连续(如已跑 1m 则显示"已工作 1m"),无重复 turn。