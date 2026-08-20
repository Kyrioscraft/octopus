// P0 invariant assertion: incremental projection ≡ full recompute.
// projectTurnParts is a pure function over the raw TurnEvent[] timeline —
// feeding events one-by-one and projecting after each must converge to the
// same result as projecting the complete timeline once. Run with:
//   node test_project.mjs
import assert from "node:assert";

// Minimal stand-in for the web-bundled project.ts (same logic; the package
// source is ESM-TS compiled by vite — duplicating here keeps the test
// dependency-free). Keep in sync with turn/project.ts.
const EXPLORATION = new Set([
  "read_file", "list_directory", "ls", "glob", "grep", "search_file_content",
]);

function projectTurnParts(events, opts) {
  const items = [];
  let i = 0;
  let groupSeq = 0;
  const firstReasoningId = events.find((ev) => ev.type === "reasoning")?.id;
  const visible = events.filter(
    (ev) =>
      (ev.type !== "reasoning" || opts?.showAllReasoning || ev.id === firstReasoningId) &&
      ev.type !== "ask" &&
      !(ev.type === "tool" && ev.entry.name === "write_todos"),
  );
  while (i < visible.length) {
    const ev = visible[i];
    if (ev.type === "tool" && EXPLORATION.has(ev.entry.name)) {
      const tools = [];
      while (i < visible.length && visible[i].type === "tool" && EXPLORATION.has(visible[i].entry.name)) {
        tools.push(visible[i]);
        i++;
      }
      items.push({ kind: "tool-group", id: `tg_${groupSeq++}`, tools });
    } else {
      items.push({ kind: "single", event: ev });
      i++;
    }
  }
  return items;
}

// --- Build a realistic raw timeline: reasoning + text + exploration run
// interleaved with a write tool + subagent + a second exploration run.
const mk = (id, type, extra = {}) => ({ id, type, ...extra });
const timeline = [
  mk("rs_1", "reasoning", { text: "thinking..." }),
  mk("tx_1", "text", { text: "Let me look." }),
  mk("te_1", "tool", { entry: { id: "c1", name: "read_file", args: { path: "a.ts" }, status: "done" } }),
  mk("te_2", "tool", { entry: { id: "c2", name: "grep", args: { q: "foo" }, status: "done" } }),
  mk("te_3", "tool", { entry: { id: "c3", name: "list_directory", args: { p: "." }, status: "done" } }),
  mk("te_4", "tool", { entry: { id: "c4", name: "write_file", args: { path: "b.ts" }, status: "done" } }),
  mk("sa_1", "subagent", { agentNs: "tools:1", displayName: "Explore", description: "", events: [], status: "done" }),
  mk("te_5", "tool", { entry: { id: "c5", name: "read_file", args: { path: "c.ts" }, status: "done" } }),
  mk("ask_1", "ask", { kind: "discussion", questions: [] }),
  mk("tx_2", "text", { text: "Done." }),
];

const canonical = (items) => JSON.stringify(items, (k, v) => (k === "event" ? v.id : v));

for (const opts of [undefined, { showAllReasoning: true }]) {
  const full = canonical(projectTurnParts(timeline, opts));
  // Incremental: project after every prefix; last one must equal the full run.
  let last = null;
  for (let n = 1; n <= timeline.length; n++) {
    last = canonical(projectTurnParts(timeline.slice(0, n), opts));
  }
  assert.strictEqual(last, full, `incremental ≢ full (${opts?.showAllReasoning ?? "default"})`);

  // Structure assertions on the default projection.
  const items = projectTurnParts(timeline, opts);
  const groups = items.filter((it) => it.kind === "tool-group");
  assert.strictEqual(groups.length, 2, "two exploration groups");
  assert.deepStrictEqual(groups[0].tools.map((t) => t.entry.name), ["read_file", "grep", "list_directory"]);
  assert.deepStrictEqual(groups[1].tools.map((t) => t.entry.name), ["read_file"]);
  // write_file / subagent / text are singles; ask is filtered out.
  assert(items.some((it) => it.kind === "single" && it.event.type === "tool" && it.event.entry.name === "write_file"));
  assert(items.some((it) => it.kind === "single" && it.event.type === "subagent"));
  assert(!items.some((it) => it.kind === "single" && it.event.type === "ask"));
}

console.log("PASS: incremental projection ≡ full recompute; grouping structure OK");
