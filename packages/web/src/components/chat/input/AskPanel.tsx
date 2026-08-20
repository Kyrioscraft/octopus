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
      if (Array.isArray(sel)) return sel.length > 0 || !!(texts[q.question_id] ?? "").trim();
      return !!sel || !!(texts[q.question_id] ?? "").trim();
    }
    return !!(texts[q.question_id] ?? "").trim();
  };

  /** Build the final ResumeRequestBody from the staged state.
   *  `overrides` lets callers inject just-clicked answers (single-select /
   *  approval click-to-send) that haven't landed in state yet. */
  const buildBody = (
    meta?: { approveForSession?: boolean },
    overrides?: {
      selections?: Record<string, string | string[]>;
      approvals?: Record<string, Approval>;
    },
  ): ResumeRequestBody => {
    if (payload.kind === "tool_approval") {
      const decisions = payload.questions.map((q) => {
        const a = overrides?.approvals?.[q.question_id] ?? approvals[q.question_id];
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
      const rawSel = overrides?.selections?.[q.question_id] ?? selections[q.question_id];
      const txt = texts[q.question_id];
      // "其他" is no longer a sentinel selection — the free-text lives in
      // `text` and IS the answer for it. Deselecting a single-choice row
      // stages "" — treat it as no selection.
      const sel = !rawSel || (Array.isArray(rawSel) && rawSel.length === 0) ? undefined : rawSel;
      return {
        question_id: q.question_id,
        ...(sel !== undefined ? { selection: sel } : {}),
        ...(txt && txt.trim() ? { text: txt.trim() } : {}),
      };
    });
    return { kind: payload.kind, answers };
  };

  /** Submit the whole answer set. `overrides` carries just-clicked answers
   *  (click-to-send) past the state update that hasn't flushed yet. */
  const submitAll = (
    meta?: { approveForSession?: boolean },
    overrides?: {
      selections?: Record<string, string | string[]>;
      approvals?: Record<string, Approval>;
    },
  ) => {
    onResolve(buildBody(meta, overrides), meta);
  };

  const canAdvance = isAnswered(current);
  // Option questions (discussion/clarify with options) always use 提交/忽略 —
  // on non-last pages 提交 stages the answer and advances.
  const isOptionQuestion =
    payload.kind !== "tool_approval" &&
    payload.kind !== "plan_approval" &&
    !!current.options?.length;

  /** Advance to next page, or submit everything from the last page. */
  const advanceOrSubmit = () => {
    if (isLast) submitAll();
    else setPage((p) => Math.min(total - 1, p + 1));
  };

  /** 忽略 — skip the current question (no selection/text) and move on. */
  const skipCurrent = () => {
    setSelections((p) => {
      const next = { ...p };
      delete next[current.question_id];
      return next;
    });
    setTexts((p) => {
      const next = { ...p };
      delete next[current.question_id];
      return next;
    });
    advanceOrSubmit();
  };
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

      {/* Current question body — only this page is mounted. `onPickOption`
          is the single-select click-to-send path: the clicked value is both
          staged and submitted immediately. */}
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
        onSubmit={advanceOrSubmit}
        onPickOption={(v) => {
          setSelections((p) => ({ ...p, [current.question_id]: v }));
          submitAll(undefined, { selections: { [current.question_id]: v } });
        }}
        onPickApproval={(a) => {
          setApprovals((p) => ({ ...p, [current.question_id]: a }));
          submitAll(
            a.type === "always" ? { approveForSession: true } : undefined,
            { approvals: { [current.question_id]: a } },
          );
        }}
        sessionAllowed={sessionAllowed}
      />

      {/* Footer toolbar — option questions use 提交/忽略; single-select and
          tool_approval are click-to-send (no footer needed); the remaining
          kinds keep the 下一题/提交 staging flow. */}
      {payload.kind !== "tool_approval" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
        {isOptionQuestion ? (
          <>
            <Button
              size="small"
              onClick={skipCurrent}
              style={{ color: "var(--gray-500)", boxShadow: "none" }}
            >
              忽略
            </Button>
            <Button
              size="small"
              icon={<Check />}
              disabled={!canAdvance}
              onClick={advanceOrSubmit}
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
          </>
        ) : isLast ? (
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
      )}
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
  /** Option questions — advance/submit the current page (Enter key etc.). */
  onSubmit: () => void;
  /** Single-select click-to-send: the option the user just clicked. */
  onPickOption: (value: string) => void;
  /** tool_approval click-to-send: the decision row the user just clicked. */
  onPickApproval: (a: { type: "approve" | "always" | "reject" }) => void;
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
  }  if (p.kind === "plan_approval") {
    return <PlanApprovalBody {...p} />;
  }
  if (p.q.options && p.q.options.length > 0) {
    const { onSubmit, onPickOption, ...rest } = p;
    return <DiscussionBody {...rest} header={QHeader} onSubmit={onSubmit} onPickOption={onPickOption} />;
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
  onPickApproval,
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
      {/* Decision as click-to-send option rows — same visual language as the
          single-select discussion rows. Clicking a row IS the answer; no
          footer submit needed. */}
      <ApprovalOptionRows
        approval={approval}
        onApproval={onApproval}
        onPick={onPickApproval}
        sessionAllowed={sessionAllowed}
        allowAlways={allowAlways}
      />
    </div>
  );
}

/**
 * Decision options rendered as click-to-send selectable rows — same visual
 * language as the single-select discussion body. Clicking a row stages the
 * decision AND submits immediately (zcode-style):
 *   批准 / 本会话都批准(always) / 拒绝
 */
function ApprovalOptionRows({
  approval,
  onPick,
  allowAlways,
}: {
  approval?: Approval;
  onApproval: (a: Approval) => void;
  onPick: (a: Approval) => void;
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
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
      {rows.map((r) => {
        const selected = approval?.type === r.value;
        return (
          <div
            key={r.value}
            onClick={() => onPick({ type: r.value })}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              borderRadius: 8,
              border: `1px solid ${selected ? (r.danger ? "var(--color-error-500)" : "var(--gray-900)") : "var(--gray-150)"}`,
              background: selected ? "var(--gray-0)" : "transparent",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
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
              <span style={{ color: "var(--gray-400)", fontSize: 12, flex: 1 }}>{r.hint}</span>
            )}
            {selected && (
              <Check
                size={14}
                style={{ color: r.danger ? "var(--color-error-500)" : "var(--gray-900)" }}
              />
            )}
          </div>
        );
      })}
    </div>
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
  onSubmit,
  onPickOption,
}: BodyProps & { header: React.ReactNode; onSubmit: () => void; onPickOption: (v: string) => void }) {
  const multi = !!q.multi_select;
  const options = q.options ?? [];

  /** Enter submits, Shift+Enter inserts a newline. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
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
        /* Single-select — no radio buttons, no confirm step: clicking a row
            IS the answer (zcode-style click-to-send). */
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {options.map((opt) => {
            const selected = selection === opt.value;
            return (
              <div
                key={opt.value}
                onClick={() => onPickOption(opt.value)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: 8,
                  border: `1px solid ${selected ? "var(--gray-900)" : "var(--gray-150)"}`,
                  background: selected ? "var(--gray-0)" : "transparent",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--gray-900)",
                    flex: 1,
                  }}
                >
                  {opt.label}
                </span>
                {opt.description && (
                  <span style={{ color: "var(--gray-400)", fontSize: 12 }}>
                    {opt.description}
                  </span>
                )}
                {selected && <Check size={14} style={{ color: "var(--gray-900)" }} />}
              </div>
            );
          })}
        </div>
      )}
      {/* "其他" — a plain textarea with a placeholder, no radio/checkbox and
          no "其他" wording. Enter submits. */}
      {q.allow_other && (
        <TextArea
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="或输入其他内容…"
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{ fontSize: 13, marginTop: 8 }}
        />
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
