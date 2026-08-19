# 实施计划:只读工具单独折叠,解决"读文件占满屏幕"

## 背景与结论

你的两个疑问都已澄清:
1. **"并行是否生效"** —— **生效**。LLM 在一个推理回合里并行发起多个 `read_file`,LangGraph 并发执行,NDJSON 交织传输,前端按 `id` 重组。你看到的"很多调用"是真实并行,不是串行 bug。
2. **"读文件占满屏幕"** —— **这是 UI 呈现问题,不是机制问题**。当前 `TurnTimeline.tsx` 的 `ToolGroupBar` 虽然有折叠,但展开后每个 `read_file` 仍是 420px 高的独立卡片堆叠,且折叠态信息太抽象(只显示"已调用 8 个工具")。

**业界做法**(Cursor/Windsurf/Claude Code):把 read_file/ls/glob/grep 这类**只读探索工具**降级呈现——折叠成一行文件名列表,点击单个文件才展开内容;而写操作(edit/write/execute)保持独立高权重卡片。

## 改动范围
**只改 `web/` 前端**,不动后端、不动数据流、不动 tentacle 类型。风险最低。

---

## 具体改动(4 个文件)

### 1. `web/src/components/toolcalls/registry.tsx` — 新增只读工具集合
在文件末尾新增一个常量(供分组逻辑判断):

```typescript
/**
 * 只读探索类工具集合。这类工具(read_file/ls/glob/grep 等)在 agent
 * 一个 turn 里经常被批量并行调用,UI 上降级呈现:折叠为一行文件名列表,
 * 而非和写操作(edit/write/execute)平起平坐地各占一张卡片。
 * 语义对齐 core 的 READONLY_TOOL_NAMES。
 */
export const READONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "ls",
  "glob",
  "grep",
  "search_file_content",
  "web_search",
  "fetch_url",
]);

/** 判断一个工具调用是否属于只读类(用于 UI 降级呈现)。 */
export function isReadonlyTool(name: string): boolean {
  return READONLY_TOOLS.has(name);
}

/**
 * 从只读工具的 args 里提取一个"人类可读的目标"(文件名/路径/搜索词),
 * 用于折叠态的 chips 显示。
 */
export function readonlyToolTarget(name: string, args: Record<string, unknown>): string {
  // read_file / list_directory / ls → file_path / path
  const fp = (args.file_path ?? args.path) as string | undefined;
  if (fp) return basename(fp);
  // glob / grep / search_file_content → pattern / query / search
  const pat = (args.pattern ?? args.query ?? args.search) as string | undefined;
  if (pat) return pat.length > 24 ? pat.slice(0, 24) + "…" : pat;
  return "";
}
```

### 2. `web/src/components/toolcalls/TurnTimeline.tsx` — 核心改造(分组内拆分只读组)

**当前**:`ToolGroupBar` 把连续工具调用收成一组,展开后逐个渲染 `ToolCallRenderer`(读/写混在一起堆叠)。

**改造后**:在一个 `ToolGroup` 内,把工具按"只读 / 非只读"二级分组:
- **只读子组** → 渲染为新的 `ReadonlyToolCluster` 组件(一行摘要 + 文件名 chips,点 chip 展开)。
- **非只读工具** → 保持原样,逐个渲染 `ToolCallRenderer`(edit/write/execute 等仍是独立卡片)。

具体改 `ToolGroupBar` 的 `children`(第 205-211 行):

```typescript
children: (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 }}>
    {/* 1. 先渲染非只读工具,保持独立卡片(高视觉权重) */}
    {writeTools.map((t) => (
      <ToolCallRenderer key={t.id} entry={t.entry} defaultExpanded={false} />
    ))}
    {/* 2. 只读工具聚合为一个紧凑集群(低视觉权重) */}
    {readonlyTools.length > 0 && (
      <ReadonlyToolCluster tools={readonlyTools} />
    )}
  </div>
),
```

其中 `readonlyTools` / `writeTools` 在 `ToolGroupBar` 顶部计算:
```typescript
const readonlyTools = tools.filter((t) => isReadonlyTool(t.entry.name));
const writeTools = tools.filter((t) => !isReadonlyTool(t.entry.name));
```

**同时优化折叠态摘要**(label):如果一组里**全是只读工具**(常见场景),把文案从"已调用 8 个工具 · [read_file]"改成更具体的"读取/搜索了 5 个文件 · [agent.ts] [config.ts] +3"。这样用户不展开就能看到读了什么。只读文件名 chips 直接复用 `readonlyToolTarget`。

### 3. `web/src/components/toolcalls/TurnTimeline.tsx`(同文件)— 新增 `ReadonlyToolCluster` 组件

在 `ToolGroupBar` 下方新增组件,负责把 N 个只读工具聚合成一个紧凑可折叠块:

```typescript
/**
 * 一组只读工具(read_file/ls/glob/grep...)的聚合视图。
 * 折叠态:一行摘要 + 文件名/搜索词 chips(每个 chip 带状态点)。
 * 展开态:仍是可点击的 chips 列表,点击单个 chip 才展开该工具的完整内容,
 * 而不是像现在把 8 个 420px 的滚动块一次性铺开。
 *
 * 这是 Cursor/Windsurf 对"探索类工具"的标准降级呈现:
 * 读操作不该和写操作平起平坐地占满屏幕。
 */
function ReadonlyToolCluster({ tools }: { tools: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // 摘要:去重后的工具类型 + 数量
  // chips:每个工具一个 chip,显示 readonlyToolTarget(name, args) + 状态点
  // 点击 chip → setActiveId → 下方渲染该工具的完整 ToolCallRenderer
  ...
}
```

设计要点:
- **折叠态**:一行 `📄 读取了 5 个文件` + chips(`agent.ts ✓` `config.ts ✓` `engine.ts ⟳` ...),chips 带状态颜色点。
- **展开态**:chips 列表 + 选中某个 chip 时,下方显示该工具的完整内容(复用 `ToolCallRenderer`)。**永远只展开一个**,不会出现 N×420px 堆叠。
- 流式时(`isActive` 且有 pending)默认展开 chips 但不展开内容。

### 4. (可选清理)`web/src/components/toolcalls/ToolCallGroup.tsx` — 删除死代码
调研确认此文件无任何 import 引用(被 `ToolGroupBar` 内联实现取代),可一并删除,减少混淆。

---

## 不改动的部分(明确边界)
- ❌ 不动后端 NDJSON 事件结构 / 不加 is_readonly 字段(纯前端判断工具名即可)。
- ❌ 不动 `TurnEventAccumulator.ts`(数据层不变,纯渲染层改造)。
- ❌ 不动 deepagents SDK 的 read_file 工具本身(保持单文件原子调用,这是业界正确做法)。
- ❌ 不动 system_prompt.md 的并行读取指导(并行是好的,要保留)。

## 验证方式
1. `cd web && npm run lint`(即 `tsc --noEmit`)—— 类型检查通过。
2. 手动验证(需要 `server` + `web` 同时跑):
   - 触发一个会读多个文件的对话(如"读一下 core/src 下的主要文件"),确认折叠态显示文件名 chips、展开后不再堆叠 8 个滚动块。
   - 确认 edit_file/execute 等写操作仍是独立卡片,视觉权重不变。
   - 确认流式过程中只读组的状态点能正确反映 pending/done。

## 预期效果
一个读 8 个文件的 turn,从现在的「展开后 8×420px = ~3360px 堆叠」变成「一行 chips(~28px)+ 按需展开单个」,屏幕占用降低约 90%,且信息密度更高(直接看到读了哪些文件)。