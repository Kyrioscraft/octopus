/**
 * AskPanel — the input-area surface for all agent-initiated user input.
 *
 * Replaces the old full-screen `ApprovalDialog` modal. When the agent needs
 * the user (tool approval, option discussion, free-text clarification), the
 * bottom input bar morphs into this panel — same container styling as the
 * regular input bar, so it feels like "the input box is now asking me
 * something" rather than a jarring popup. The text textarea is disabled by
 * the surrounding `busy` state, so the user can't type a new message while a
 * question is pending (semantically: answering the question IS the input).
 *
 * Pagination: multiple questions are shown ONE AT A TIME. The pagination
 * control (prev/next chevrons + "1/3" indicator) lives in the header's
 * top-right corner; each answered question unlocks the next, and the final
 * question's primary button submits the full answer set.
 *
 * Three `kind`, dispatched by QuestionBody:
 *   - tool_approval : one row per pending tool call, approve/reject (+ session).
 *   - discussion    : Radio/Checkbox options + optional "Other…" free text.
 *   - clarify       : a TextArea.
 *
 * Styling is deliberately restrained — neutral grayscale palette (no brand
 * green), no drop shadows, just a 1px border + generous spacing so it reads
 * as a first-class part of the input bar rather than a foreign popup.
 * Primary actions use a solid --gray-900 fill; reject uses a red outline.
 */

import { useState } from "react";
import { Button, Input, Radio, Checkbox } from "antd";
import type {
  AskKind,
  AskQuestion,
  AskUserQuestionPayload,
  ResumeRequestBody,
} from "@octopus/tentacle";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  CircleHelp,
  ClipboardList,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";

const { TextArea } = Input;

// Button style presets — clean, animated, no antd primary dependency.
const S = {
  mainBase: {
    background: "var(--gray-900)",
    color: "var(--gray-0)",
    border: "1px solid var(--gray-900)",
    boxShadow: "none",
    transition: "all 0.18s ease",
  } as React.CSSProperties,
  mainHover: {
    background: "var(--gray-700)",
    border: "1px solid var(--gray-700)",
    boxShadow: "0 1px 3px var(--shadow-1)",
  } as React.CSSProperties,
  mainPress: {
    background: "var(--gray-600)",
    border: "1px solid var(--gray-600)",
    boxShadow: "none",
  } as React.CSSProperties,
};

/** Merge style objects — later objects override earlier ones. */
const css = (...styles: (React.CSSProperties | undefined | false)[]): React.CSSProperties =>
  Object.assign({}, ...styles.filter(Boolean));

interface Props {
  payload: AskUserQuestionPayload;
  /** Called with the user's structured answer. Parent resumes the stream. */
  onResolve: (body: ResumeRequestBody, meta?: { approveForSession?: boolean }) => void;
  /** tool_approval only — tools already allowed this session. */
  sessionAllowlist?: Set<string>;
}

export function AskPanel({ payload, onResolve, sessionAllowlist }: Props) {
  const total = payload.questions.length;
  const [page, setPage] = useState(0);
  const current = payload.questions[page];
  const isLast = page === total - 1;

  // Per-question answer staging. Keyed by question_id so pagination doesn't
  // lose state when the user flips back and forth.
  type Approval = { type: "approve" | "always" | "reject" };
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  /** Does `q` have a staged answer yet? Drives the "next" button gating. */
  const isAnswered = (q: AskQuestion): boolean => {
    if (payload.kind === "tool_approval") {
      return !!approvals[q.question_id];
    }
    if (payload.kind === "plan_approval") {
      const a = approvals[q.question_id];
      // Approved → ready. Rejected → ready immediately (feedback optional).
      return a?.type === "approve" || a?.type === "reject";
    }
    if (q.options && q.options.length > 0) {
      const sel = selections[q.question_id];
      if (Array.isArray(sel)) {
        // "其他" counts only when the free-text is filled.
        const concrete = sel.filter((v) => v !== "__other__");
        if (concrete.length > 0) return true;
        return sel.includes("__other__") && !!(texts[q.question_id] ?? "").trim();
      }
      if (sel === "__other__") return !!(texts[q.question_id] ?? "").trim();
      return !!sel;
    }
    return !!(texts[q.question_id] ?? "").trim();
  };

  /** Build the final ResumeRequestBody from the staged state.
   *  (`meta.approveForSession` is legacy — "always" now comes through the
   *  staged approval itself, selected as an option row in the body.) */
  const buildBody = (meta?: { approveForSession?: boolean }): ResumeRequestBody => {
    if (payload.kind === "tool_approval") {
      const decisions = payload.questions.map((q) => {
        const a = approvals[q.question_id];
        if (!a) return { type: "approve" as const };
        if (a.type === "always") {
          return {
            type: "always" as const,
            ...(q.context?.source ? { tool: q.context.source } : {}),
          };
        }
        return a;
      });
      return { kind: "tool_approval", decisions };
    }
    if (payload.kind === "plan_approval") {
      // Single plan verdict: approved flag + optional rejection feedback.
      const a = approvals[payload.questions[0]?.question_id ?? "plan"];
      const fb = (texts[payload.questions[0]?.question_id ?? "plan"] ?? "").trim();
      return {
        kind: "plan_approval",
        approved: a?.type === "reject" ? false : true,
        ...(fb && a?.type === "reject" ? { feedback: fb } : {}),
      };
    }
    const answers = payload.questions.map((q) => {
      const rawSel = selections[q.question_id];
      const txt = texts[q.question_id];
      // Strip the "其他" sentinel — the free-text IS the answer for it.
      const sel = Array.isArray(rawSel)
        ? rawSel.filter((v) => v !== "__other__")
        : rawSel === "__other__"
          ? undefined
          : rawSel;
      return {
        question_id: q.question_id,
        ...(sel !== undefined && (Array.isArray(sel) ? sel.length > 0 : true)
          ? { selection: sel }
          : {}),
        ...(txt && txt.trim() ? { text: txt.trim() } : {}),
      };
    });
    return { kind: payload.kind, answers };
  };

  /** Submit the whole answer set (called from the last page's primary btn). */
  const submitAll = (meta?: { approveForSession?: boolean }) => {
    onResolve(buildBody(meta), meta);
  };

  const canAdvance = isAnswered(current);
  const sessionAllowed =
    payload.kind === "tool_approval" &&
    !!sessionAllowlist &&
    !!current.context?.source &&
    sessionAllowlist.has(current.context.source);

  // Hover/press state for the primary action button.
  const [mainState, setMainState] = useState<"base" | "hover" | "press">("base");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--gray-25)",
        border: "1px solid var(--gray-150)",
        borderRadius: 12,
        padding: "14px 16px 12px",
      }}
    >
      {/* Header row: kind label (left) + pagination control (right). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <AskKindLabel kind={payload.kind} />
        {total > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Button
              type="text"
              size="small"
              icon={<ChevronLeft />}
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              style={{ color: page === 0 ? "var(--gray-200)" : "var(--gray-500)" }}
            />
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--gray-600)",
                minWidth: 32,
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
                userSelect: "none",
              }}
            >
              {page + 1} / {total}
            </span>
            <Button
              type="text"
              size="small"
              icon={<ChevronRight />}
              disabled={!canAdvance || isLast}
              onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
              style={{
                color: !canAdvance || isLast ? "var(--gray-200)" : "var(--gray-500)",
              }}
            />
          </div>
        )}
      </div>

      {/* Current question body — only this page is mounted. */}
      <QuestionBody
        key={current.question_id}
        kind={payload.kind}
        q={current}
        approval={approvals[current.question_id]}
        onApproval={(a) => setApprovals((p) => ({ ...p, [current.question_id]: a }))}
        selection={selections[current.question_id]}
        onSelection={(s) => setSelections((p) => ({ ...p, [current.question_id]: s }))}
        text={texts[current.question_id] ?? ""}
        onText={(t) => setTexts((p) => ({ ...p, [current.question_id]: t }))}
        sessionAllowed={sessionAllowed}
      />

      {/* Footer toolbar — primary action only (pagination moved to header).
          All kinds share the same 下一题/提交 flow now that approvals are
          staged as option rows in the body (no per-kind button clusters). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 12,
        }}
      >
        {isLast ? (
          <Button
            size="small"
            icon={<Check />}
            disabled={!canAdvance}
            onClick={() => submitAll()}
            style={css(
              S.mainBase,
              mainState === "hover" && S.mainHover,
              mainState === "press" && S.mainPress,
            )}
            onMouseEnter={() => setMainState("hover")}
            onMouseLeave={() => setMainState("base")}
            onMouseDown={() => setMainState("press")}
            onMouseUp={() => setMainState("hover")}
          >
            提交
          </Button>
        ) : (
          <Button
            size="small"
            disabled={!canAdvance}
            onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
            style={css(
              S.mainBase,
              mainState === "hover" && S.mainHover,
              mainState === "press" && S.mainPress,
            )}
            onMouseEnter={() => setMainState("hover")}
            onMouseLeave={() => setMainState("base")}
            onMouseDown={() => setMainState("press")}
            onMouseUp={() => setMainState("hover")}
          >
            下一题
          </Button>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

/** Small inline kind label with matching glyph — no background chip. */
function AskKindLabel({ kind }: { kind: AskKind }) {
  const meta = (() => {
    switch (kind) {
      case "tool_approval":
        return { icon: <TriangleAlert />, label: "需要批准", color: "var(--color-warning-500)" };
      case "plan_approval":
        return { icon: <ClipboardList />, label: "计划审批", color: "var(--color-info-500)" };
      case "discussion":
        return { icon: <MessageSquare />, label: "方案选择", color: "var(--color-info-500)" };
      case "clarify":
        return { icon: <CircleHelp />, label: "需要澄清", color: "var(--gray-900)" };
    }
  })();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        fontWeight: 500,
        color: meta.color,
      }}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

// =============================================================================
// QuestionBody — dispatches by kind, renders the current question only.
// =============================================================================

interface BodyProps {
  kind: AskKind;
  q: AskQuestion;
  approval?: Approval;
  onApproval: (a: Approval) => void;
  selection?: string | string[];
  onSelection: (s: string | string[]) => void;
  text: string;
  onText: (t: string) => void;
  sessionAllowed: boolean;
}

function QuestionBody(p: BodyProps) {
  // Question text — common header for all kinds.
  const QHeader = (
    <div style={{ fontSize: 14, fontWeight: 500, color: "var(--gray-900)", marginBottom: 8 }}>
      {p.q.question}
    </div>
  );

  if (p.kind === "tool_approval") {
    return <ToolApprovalBody {...p} header={QHeader} />;
  }
  if (p.kind === "plan_approval") {
    return <PlanApprovalBody {...p} />;
  }
  if (p.q.options && p.q.options.length > 0) {
    return <DiscussionBody {...p} header={QHeader} />;
  }
  return <ClarifyBody {...p} header={QHeader} />;
}

// -----------------------------------------------------------------------------
// tool_approval body — tool name + arg preview + inline decision pills.
// No background tint; separation comes from the arg-preview block + spacing.
// -----------------------------------------------------------------------------

function ToolApprovalBody({
  q,
  header,
  approval,
  onApproval,
  sessionAllowed,
}: BodyProps & { header: React.ReactNode }) {
  const actionReq = q.context?.actionRequests?.[0];
  const toolName = q.context?.source ?? q.header ?? "工具";
  const allowAlways = !sessionAllowed;
  const previewKey = actionReq?.args
    ? Object.keys(actionReq.args).find((k) =>
        ["command", "file_path", "path", "url", "query"].includes(k),
      )
    : undefined;
  const previewVal = previewKey
    ? String((actionReq!.args as Record<string, unknown>)[previewKey])
    : undefined;
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ paddingLeft: 2 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--gray-900)",
          }}
        >
          {toolName}
        </span>
        {sessionAllowed && (
          <span style={{ fontSize: 11, color: "var(--gray-400)" }}>· 已自动批准</span>
        )}
      </div>
      {/* "Why am I being asked" — the matched permission rule, embedded by the
          dynamic HITL description (see _addInterruptOn in core/agent.ts).
          Rendered as a subdued chip so it reads as provenance, not question. */}
      {(() => {
        const m = /\(matched permission rule "([^"]+)" → (\w+)\)/.exec(q.question ?? "");
        if (!m) return null;
        return (
          <div
            style={{
              fontSize: 11,
              color: "var(--gray-500)",
              background: "var(--gray-50)",
              border: "1px solid var(--gray-150)",
              borderRadius: 6,
              padding: "3px 8px",
              marginBottom: 6,
              width: "fit-content",
            }}
          >
            触发规则: <code style={{ fontSize: 11 }}>{m[1]}</code> → {m[2]}
          </div>
        );
      })()}
      {/* Only show the question text if it adds info beyond the tool name AND
          beyond the rule chip above (strip the embedded rule annotation). */}
      {(() => {
        const stripped = (q.question ?? "").replace(/\s*\(matched permission rule "[^"]+" → \w+\)/, "");
        if (!q.question || q.question === `批准执行: ${toolName}?` || !stripped.trim()) return null;
        return (
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--gray-900)", marginBottom: 8 }}>
            {stripped}
          </div>
        );
      })()}
      {previewVal && (
        <div
          onClick={() => setExpanded((v) => !v)}
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            color: "var(--gray-600)",
            border: "1px solid var(--gray-150)",
            borderRadius: 6,
            padding: "5px 9px",
            marginBottom: 4,
            cursor: "pointer",
            whiteSpace: expanded ? "pre-wrap" : "nowrap",
            overflow: expanded ? "visible" : "hidden",
            textOverflow: "ellipsis",
          }}
          title={expanded ? undefined : previewVal}
        >
          {previewKey}: {previewVal}
        </div>
      )}
      {expanded && actionReq?.args && (
        <pre
          style={{
            margin: "4px 0 0",
            fontSize: 11,
            color: "var(--gray-500)",
            padding: 8,
            borderRadius: 6,
            border: "1px solid var(--gray-150)",
            overflow: "auto",
            maxHeight: 140,
          }}
        >
          {JSON.stringify(actionReq.args, null, 2)}
        </pre>
      )}
      {/* Decision as option rows — same visual language as the discussion
          body (radio-style selectable rows) instead of footer buttons. */}
      <ApprovalOptionRows
        approval={approval}
        onApproval={onApproval}
        sessionAllowed={sessionAllowed}
        allowAlways={allowAlways}
      />
    </div>
  );
}

/**
 * Decision options rendered as selectable rows (radio-style), matching the
 * discussion body's visual language. Replaces the old footer button cluster:
 *   批准 / 本会话都批准(always) / 拒绝
 * Selecting a row stages the decision; the footer's 提交/下一题 button
 * advances/submits like the discussion flow.
 */
function ApprovalOptionRows({
  approval,
  onApproval,
  sessionAllowed,
  allowAlways,
}: {
  approval?: Approval;
  onApproval: (a: Approval) => void;
  sessionAllowed: boolean;
  allowAlways: boolean;
}) {
  const rows: Array<{ value: Approval["type"]; label: string; hint?: string; danger?: boolean }> = [
    { value: "approve", label: "批准" },
    ...(allowAlways
      ? [{ value: "always" as const, label: "本会话都批准", hint: "本次会话内对该工具自动批准" }]
      : []),
    { value: "reject", label: "拒绝", danger: true },
  ];
  return (
    <Radio.Group
      value={approval?.type ?? ""}
      onChange={(e) => {
        const v = e.target.value as Approval["type"];
        onApproval({ type: v });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}
    >
      {rows.map((r) => (
        <Radio key={r.value} value={r.value}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: r.danger ? "var(--color-error-500)" : "var(--gray-900)",
            }}
          >
            {r.label}
          </span>
          {r.hint && (
            <span style={{ color: "var(--gray-400)", marginLeft: 6, fontSize: 12 }}>
              {r.hint}
            </span>
          )}
          {sessionAllowed && r.value === "approve" && (
            <span style={{ fontSize: 11, color: "var(--gray-400)", marginLeft: 6 }}>
              （已在会话白名单，将自动批准）
            </span>
          )}
        </Radio>
      ))}
    </Radio.Group>
  );
}


// -----------------------------------------------------------------------------
// plan_approval body — the full plan text (scrollable) + decision option
// rows; rejection reveals a feedback input (same visual language as the
// discussion body's "Other…" inline input).
// -----------------------------------------------------------------------------

function PlanApprovalBody({ q, approval, onApproval, text, onText }: BodyProps) {
  return (
    <div style={{ paddingLeft: 2, width: "100%" }}>
      <pre
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--gray-800)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "inherit",
          maxHeight: 320,
          overflow: "auto",
          border: "1px solid var(--gray-150)",
          borderRadius: 8,
          padding: "10px 12px",
          background: "var(--gray-0)",
        }}
      >
        {q.question}
      </pre>
      <Radio.Group
        value={approval?.type ?? ""}
        onChange={(e) => onApproval({ type: e.target.value as Approval["type"] })}
        style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}
      >
        <Radio value="approve">
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--gray-900)" }}>
            批准并执行
          </span>
          <span style={{ color: "var(--gray-400)", marginLeft: 6, fontSize: 12 }}>
            切换到 confirm 智能体开始实现
          </span>
        </Radio>
        <Radio value="reject">
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-error-500)" }}>
            拒绝并修改
          </span>
          <span style={{ color: "var(--gray-400)", marginLeft: 6, fontSize: 12 }}>
            继续计划模式，按反馈修订
          </span>
        </Radio>
      </Radio.Group>
      {approval?.type === "reject" && (
        <TextArea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="修改意见（可选）——告诉代理哪里需要调整…"
          autoSize={{ minRows: 2, maxRows: 6 }}
          autoFocus
          style={{ fontSize: 13, marginTop: 8 }}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// discussion body — Radio (single) or Checkbox (multi) + optional "Other…".
// -----------------------------------------------------------------------------

function DiscussionBody({
  q,
  selection,
  onSelection,
  text,
  onText,
  header,
}: BodyProps & { header: React.ReactNode }) {
  const multi = !!q.multi_select;
  const options = q.options ?? [];
  const OTHER = "__other__";
  // Selection state carries OTHER when the "其他" row is picked; the actual
  // free-text lives in `text`. Submit (buildBody) strips OTHER and keeps the
  // text so the agent only sees the typed answer.
  const sel = selection as string | string[] | undefined;
  const isOtherSelected = multi
    ? Array.isArray(sel) && sel.includes(OTHER)
    : sel === OTHER;

  const pickOther = () => {
    if (multi) {
      const cur = Array.isArray(sel) ? sel : [];
      onSelection(cur.includes(OTHER) ? cur.filter((v) => v !== OTHER) : [...cur, OTHER]);
    } else {
      onSelection(OTHER);
    }
  };

  return (
    <div style={{ paddingLeft: 2 }}>
      {header}
      {multi ? (
        <Checkbox.Group
          value={(selection as string[]) ?? []}
          onChange={(v) => onSelection(v as string[])}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          {options.map((opt) => (
            <Checkbox key={opt.value} value={opt.value}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--gray-900)" }}>
                {opt.label}
              </span>
              {opt.description && (
                <span style={{ color: "var(--gray-400)", marginLeft: 6, fontSize: 12 }}>
                  {opt.description}
                </span>
              )}
            </Checkbox>
          ))}
        </Checkbox.Group>
      ) : (
        <Radio.Group
          value={(selection as string) ?? ""}
          onChange={(e) => onSelection(e.target.value as string)}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          {options.map((opt) => (
            <Radio key={opt.value} value={opt.value}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--gray-900)" }}>
                {opt.label}
              </span>
              {opt.description && (
                <span style={{ color: "var(--gray-400)", marginLeft: 6, fontSize: 12 }}>
                  {opt.description}
                </span>
              )}
            </Radio>
          ))}
        </Radio.Group>
      )}
      {/* "其他" — an option row WITH an inline input (not a detached
          textarea below the options). Typing selects the row automatically. */}
      {q.allow_other && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            marginTop: 8,
            padding: isOtherSelected ? "6px 8px" : 0,
            borderRadius: 6,
            border: isOtherSelected ? "1px solid var(--gray-300)" : "1px solid transparent",
            background: isOtherSelected ? "var(--gray-0)" : "transparent",
            transition: "all 0.15s ease",
          }}
        >
          {multi ? (
            <Checkbox checked={isOtherSelected} onChange={pickOther} style={{ marginTop: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--gray-900)" }}>其他…</span>
            </Checkbox>
          ) : (
            <Radio checked={isOtherSelected} onClick={pickOther} style={{ marginTop: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--gray-900)" }}>其他…</span>
            </Radio>
          )}
          <TextArea
            value={text}
            onChange={(e) => {
              onText(e.target.value);
              // Typing implies choosing "其他" — auto-select the row.
              if (e.target.value && !isOtherSelected) pickOther();
            }}
            placeholder="自由输入…"
            autoSize={{ minRows: 1, maxRows: 4 }}
            style={{ fontSize: 13, flex: 1, marginTop: 0 }}
          />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// clarify body — just a TextArea. Mirrors the input bar's own textarea
// sizing (minRows 2) so the morphed panel feels continuous with it.
// -----------------------------------------------------------------------------

function ClarifyBody({ q, text, onText, header }: BodyProps & { header: React.ReactNode }) {
  return (
    <div style={{ paddingLeft: 2 }}>
      {header}
      <TextArea
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="输入你的回答…"
        autoSize={{ minRows: 2, maxRows: 8 }}
        autoFocus
        style={{ fontSize: 14 }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Collapsed-summary helper — used by EventRow's read-only timeline trace.
// Exported so the timeline can render the outcome of a resolved AskEvent in
// the same wording as the panel would.
// -----------------------------------------------------------------------------

type Approval = { type: "approve" | "always" | "reject" };

/** Build a short human-readable summary of a resolved AskEvent. */
export function summarizeResolution(
  kind: AskKind,
  questions: AskQuestion[],
  resolution?: ResumeRequestBody,
): string {
  if (!resolution) return "等待回答…";
  if (kind === "plan_approval") {
    return resolution.approved === false
      ? `✗ 计划已拒绝${resolution.feedback ? ` · ${resolution.feedback}` : ""}`
      : "✓ 计划已批准 · 开始执行";
  }
  if (kind === "tool_approval") {
    const decisions = resolution.decisions ?? [];
    if (decisions.length === 0) return "已响应";
    const types = decisions.map((d) => d.type);
    const allApprove = types.every((t) => t === "approve");
    const allReject = types.every((t) => t === "reject");
    const names = questions
      .map((q) => q.context?.source ?? q.header ?? "工具")
      .join(", ");
    if (allApprove) return `✓ 已批准 · ${names}`;
    if (allReject) return `✗ 已拒绝 · ${names}`;
    return `已响应 · ${names}`;
  }
  const answers = resolution.answers ?? [];
  if (answers.length === 0) return "已响应";
  const parts = answers.map((a) => {
    if (a.text && !a.selection) return a.text;
    if (Array.isArray(a.selection)) {
      const q = questions.find((qq) => qq.question_id === a.question_id);
      const labels = (a.selection as string[]).map(
        (v) => q?.options?.find((o) => o.value === v)?.label ?? v,
      );
      return labels.join(", ");
    }
    if (a.selection) {
      const q = questions.find((qq) => qq.question_id === a.question_id);
      const label = q?.options?.find((o) => o.value === a.selection)?.label ?? a.selection;
      return a.text ? `${label} (${a.text})` : String(label);
    }
    return a.text ?? "已回答";
  });
  return `已回答: ${parts.join("; ")}`;
}
