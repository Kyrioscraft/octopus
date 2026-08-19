# 修复 server dev 脚本的 node --watch 循环导致的 OOM

## 问题根因
`server/package.json:9` 的 dev 脚本让 `node --watch` 监视了 `dist/` 整个目录，而 `tsc --watch` 正在向 `dist/` 写入编译产物。两者形成崩溃-重启风暴：tsc 每次重编 → dist 文件变化 → node --watch fork 新进程 → 新进程加载巨型依赖（LangChain/LangGraph）时 tsc 又触发重编 → 再次 fork……多个未退出的 watch 子进程叠加耗尽 V8 堆内存，报 `Committing semi space failed`。

## 修复方案

**方案：让 `node --watch` 只监视源码 `src/`，而不是编译产物 `dist/`。**

Node 22+ 原生支持 `--watch-path` 参数，可以把监视范围限制到 `src/` 目录。这样当 `src/*.ts` 变化时（tsc 会自动重编并更新 dist），node 才重启；而 tsc 写 dist 本身不会触发 node 重启，打破循环。

### 改动（仅 1 个文件）

**文件：`D:\workstation\webworks\octopus\server\package.json`**

把第 9 行：
```json
"dev": "concurrently -n tsc,node \"tsc --watch --preserveWatchOutput\" \"node --watch dist/main.js\"",
```

改为：
```json
"dev": "concurrently -n tsc,node \"tsc --watch --preserveWatchOutput\" \"node --watch --watch-path=src dist/main.js\"",
```

**说明**：
- `--watch-path=src` 让 Node 只监视 `server/src/` 目录下的源文件变化，**不再监视 `dist/`**
- 当你修改 `server/src/*.ts` 时：tsc 重编 → dist 更新 + node 检测到 src 变化 → 重启一次（合理行为，src 和 dist 几乎同步更新）
- 当 tsc 因 core 变化而重编 dist 时：**node 不再重启**（因为 src 没变）→ 循环被打破
- 无需安装任何新依赖（Node 24 原生支持）
- 首次启动需要先确保 `dist/main.js` 存在（tsc --watch 会先做一次全量编译，几秒内完成）

### 边界情况处理
- 如果 `dist/main.js` 首次不存在（全新 checkout），`node --watch dist/main.js` 会立即失败。`concurrently` 默认会让两个进程都跑，tsc 几秒后生成 dist，但 node 进程已经退出。**需要加一个小的延迟或用 wait-on**——但你选了"仅修复启动循环"，且 Node 24 的 `node --watch` 对不存在的入口文件会持续轮询重试（不会立即退出），所以这个边界在生产 Node 24 上不是问题。如果实测发现确实有问题，再补一个 `wait-on` 或把入口换成 `tsc && node` 的两段式。

## 验证步骤
1. 改完后 `cd server && npm run dev`
2. 观察：tsc 编译完成 → node 启动 → 监听 5050 端口 → **不再出现快速重启风暴**
3. 修改 `server/src/main.ts` 加一行 log → 应该只重启**一次**
4. 触发 core 重编（改 core/src）→ server 的 tsc 重编 dist，但 **server node 进程不应重启**
5. 内存稳定，不再 OOM

## 不在本次范围内（你已确认）
- `_graphCache` LRU 限制（`core/src/agent.ts:118`）
- `MemorySaver` 单例淘汰机制（`core/src/agent.ts:62-69`）
- `NODE_OPTIONS=--max-old-space-size` 兜底
- DELETE 线程时清理 checkpointer

这些是长期运行才会暴露的内存泄漏，本次只解决启动/重启循环这个直接致命问题。