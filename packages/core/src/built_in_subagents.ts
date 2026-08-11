/**
 * Built-in subagent registry — a unified, decoupled catalog of all built-in
 * subagents (Explore, general-purpose, and any future additions).
 *
 * This module is the single source of truth for "which subagents ship with
 * Octopus". It decouples the catalog from `agent.ts` (graph construction) and
 * `server` (config UI): both consume `BUILTIN_SUBAGENTS` without needing to
 * know about individual subagents.
 *
 * ## The `injectedBy` asymmetry
 *
 * Built-in subagents fall into two categories that must be injected into the
 * compiled graph differently:
 *
 * - `"explicit"` — we own the spec (e.g. Explore). `agent.ts` adds it to the
 *   `subagents` array passed to `createDeepAgent`. We control its tools/model.
 * - `"sdk"` — the deepagents SDK auto-injects it into the graph (e.g.
 *   general-purpose, included by default). We do NOT pass it to `createDeepAgent`
 *   (that would create a duplicate); we only mirror it into the registry so the
 *   UI/event layer can describe it uniformly.
 *
 * Both kinds are mirrored into `subagentRegistry` (agent.ts) so that
 * `wrapAgentStream` can resolve a subagent's systemPrompt regardless of who
 * injected it.
 *
 * ## Extensibility
 *
 * Adding a new built-in subagent is a one-line change: define a `BuiltInSubagent`
 * constant and push it into `BUILTIN_SUBAGENTS`. No changes to `agent.ts` or the
 * server config route are needed.
 */

import { GENERAL_PURPOSE_SUBAGENT } from "deepagents";

// =============================================================================
// Types
// =============================================================================

/** How a built-in subagent gets injected into the compiled graph. */
export type BuiltinSubagentInjector = "explicit" | "sdk";

/**
 * Unified description of a built-in subagent.
 *
 * `injectedBy` distinguishes explicit (we inject via createDeepAgent) from sdk
 * (deepagents auto-injects; we only mirror it in the registry).
 */
export interface BuiltInSubagent {
  /** Identifier used to select this subagent via the `task` tool. */
  name: string;
  /** Description shown to the model when it decides which subagent to delegate to. */
  description: string;
  /** System prompt for the subagent. */
  systemPrompt: string;
  /**
   * Tool-name whitelist. When set, the subagent only has access to the named
   * tools (filtered from the main agent's toolset). When undefined, the
   * subagent inherits all of the main agent's tools.
   *
   * Explore forces READONLY_TOOL_NAMES to guarantee it cannot mutate state.
   */
  tools?: string[];
  /** Optional model override in 'provider:model-name' format. null = inherit main model. */
  model?: string | null;
  /** Always "builtin" — distinguishes from file/user-defined subagents. */
  source: "builtin";
  /** How this subagent is injected into the graph (see module docstring). */
  injectedBy: BuiltinSubagentInjector;
}

// =============================================================================
// Read-only tool whitelist
// =============================================================================

/**
 * The read-only tool set. Used to enforce Explore's read-only guarantee, and
 * offered as a safe default reference for user-defined subagents.
 *
 * Deliberately excludes all destructive tools (write_file, edit_file, execute,
 * task, compact_conversation, async task tools) — anything in DESTRUCTIVE_TOOLS.
 */
export const READONLY_TOOL_NAMES = [
  "read_file",
  "ls",
  "glob",
  "grep",
  "web_search",
  "fetch_url",
] as const;

// =============================================================================
// Explore — read-only parallel search subagent (à la Claude Code)
// =============================================================================

/**
 * Explore: a read-only subagent specialized for broad code/content exploration.
 *
 * Design goals (reference: Claude Code's Explore agent):
 *   - Read-only — can never modify files (enforced by READONLY_TOOL_NAMES).
 *   - Fan-out — kicks off several parallel searches when unsure where to look.
 *   - Conclusion-oriented — reads excerpts, not whole files; returns the answer
 *     plus `file_path:line` references, never a raw file dump.
 *   - Delegate when uncertain — the main agent should hand off to Explore when
 *     it is not confident it will find the right match in the first few tries.
 */
export const EXPLORE_SUBAGENT: BuiltInSubagent = {
  name: "Explore",
  description:
    "只读探索子智能体（首选用于代码/文件的搜索、定位、调研）。当任务涉及搜索关键词、定位文件、" +
    "理解代码结构、回答\"X 在哪里/怎么实现的\"这类问题时，优先使用 Explore，而不是 general-purpose。" +
    "它只读不改，并行扇出多条搜索路径，读取摘要而非转储整个文件，最终给出结论与 file_path:line 引用。" +
    "Reach for this when you are searching for a keyword or file and are not confident that you will find the right match in the first few tries; specify search breadth (medium/very thorough). " +
    "每次调用应是一个聚焦、自包含的子任务——尤其当你作为并行 fan-out 的一部分被启动时，专注于你被分配的范围，不要试图覆盖其他子智能体可能正在探索的区域。",
  systemPrompt: `你是 Explore，一个只读探索子智能体。你的职责是在代码库或给定上下文中进行广度搜索、快速定位信息，并把结论汇报给主智能体。

工作原则：
1. 只读：你只能使用只读工具（read_file / ls / glob / grep / web_search / fetch_url）。绝不能写文件、编辑文件、执行命令或调用 task 工具。
2. 并行扇出：当不确定答案在哪里时，同时发起多条搜索（多个 grep / glob / read_file），而不是串行地一次次试探。这样能最快收敛。
3. 读摘要而非全文：read_file 时优先关注关键片段，不要把整个文件内容原样转储回主智能体。提取与问题相关的部分即可。
4. 给结论 + 引用：汇报时先给结论，再附上 \`file_path:line\` 形式的引用，让主智能体能直接定位。引用要精确。
5. 聚焦后收尾：一旦收集到足够信息回答问题，立即停止搜索并返回结构化的结论。不要过度探索。
6. 诚实汇报：如果搜索后仍未找到答案，如实说明已尝试的路径与未命中的原因，不要编造。

记住：你的输出会作为工具结果返回给主智能体（用户看不到），所以要给出主智能体能直接使用的结论，而不是半成品。`,
  tools: [...READONLY_TOOL_NAMES],
  model: null,
  source: "builtin",
  injectedBy: "explicit",
};

// =============================================================================
// general-purpose — SDK adapter (mirror only, no re-injection)
// =============================================================================

/**
 * Adapter for the deepagents SDK's general-purpose subagent.
 *
 * The SDK auto-injects general-purpose into the compiled graph (it is the
 * default catch-all subagent). We do NOT re-inject it via createDeepAgent —
 * that would create a duplicate. This entry only exists so the unified
 * registry (and the web UI) can describe it alongside Explore.
 *
 * `tools: undefined` means "inherit all of the main agent's tools", matching
 * the SDK's behavior for general-purpose.
 */
export const GENERAL_PURPOSE_BUILTIN: BuiltInSubagent = {
  name: GENERAL_PURPOSE_SUBAGENT.name,
  description: GENERAL_PURPOSE_SUBAGENT.description,
  systemPrompt: GENERAL_PURPOSE_SUBAGENT.systemPrompt,
  tools: undefined,
  model: null,
  source: "builtin",
  injectedBy: "sdk",
};

// =============================================================================
// Registry — the single source of truth
// =============================================================================

/**
 * All built-in subagents, in display order.
 *
 * To add a new built-in subagent: define a `BuiltInSubagent` constant above and
 * add it to this array. `agent.ts` and the server config route iterate this
 * array, so no other changes are needed.
 */
export const BUILTIN_SUBAGENTS: BuiltInSubagent[] = [
  EXPLORE_SUBAGENT,
  GENERAL_PURPOSE_BUILTIN,
];
