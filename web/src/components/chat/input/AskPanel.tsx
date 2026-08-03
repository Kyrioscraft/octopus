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
 * Pagination: multiple questions are shown ONE AT A TIME with prev/next
 * chevrons + a "1/3" indicator. Each answered question unlocks the next;
 * the final question's primary button submits the full answer set.
 *
 * Three `kind`, dispatched by QuestionBody:
 *   - tool_approval : one row per pending tool call, approve/reject (+ session).
 *   - discussion    : Radio/Checkbox options + optional "Other…" free text.
 *   - clarify       : a TextArea.
 *
 * Styling is deliberately restrained — no tinted backgrounds, just spacing,
 * font-weight, and a 2px left accent rule per kind — so it reads as a
 * first-class part of the input bar rather than a foreign popup.
 */

import { useState } from "react";
import { Button, Input, Radio, Checkbox, Tooltip } from "antd";
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
  MessageSquare,
  TriangleAlert,
} from "lucide-react";

const { TextArea } = Input;

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
  type Approval = { type: "approve" | "reject" };
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  /** Does `q` have a staged answer yet? Drives the "next" button gating. */
  const isAnswered = (q: AskQuestion): boolean => {
    if (payload.kind === "tool_approval") {
      return !!approvals[q.question_id];
    }
    if (q.options && q.options.length > 0) {
      const sel = selections[q.question_id];
      return Array.isArray(sel) ? sel.length > 0 : !!sel;
    }
    return !!(texts[q.question_id] ?? "").trim();
  };

  /** Build the final ResumeRequestBody from the staged state. */
  const buildBody = (meta?: { approveForSession?: boolean }): ResumeRequestBody => {
    if (payload.kind === "tool_approval") {
      const decisions = payload.questions.map((q) => {
        const a = approvals[q.question_id];
        return a ?? { type: "approve" as const };
      });
      return { kind: "tool_approval", decisions };
    }
    const answers = payload.questions.map((q) => {
      const sel = selections[q.question_id];
      const txt = texts[q.question_id];
      return {
        question_id: q.question_id,
        ...(sel !== undefined ? { selection: sel } : {}),
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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--gray-0)",
        border: "1px solid var(--gray-150)",
        borderRadius: 13,
        padding: "12px 14px 10px",
        boxShadow: "0 2px 8px var(--shadow-1)",
        transition: "box-shadow 0.3s ease, border-color 0.3s ease",
      }}
    >
      {/* Header row: kind label + pagination indicator. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <AskKindLabel kind={payload.kind} />
        {total > 1 && (
          <span style={{ fontSize: 12, color: "var(--gray-400)" }}>
            {page + 1} / {total}
          </span>
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

      {/* Footer toolbar — mirrors inputBar's bottom row layout:
          left cluster (pagination), spacer, right cluster (primary action). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 12,
        }}
      >
        {/* Left: prev chevron (disabled on first page) */}
        <Button
          type="text"
          size="small"
          icon={<ChevronLeft />}
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        />
        {/* Page dots when multi-question — subtle progress indicator. */}
        {total > 1 && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {payload.questions.map((q, i) => (
              <span
                key={q.question_id}
                onClick={() => setPage(i)}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  cursor: "pointer",
                  background:
                    i === page
                      ? "var(--main-500)"
                      : isAnswered(payload.questions[i])
                        ? "var(--main-200)"
                        : "var(--gray-200)",
                  transition: "background 0.2s ease",
                }}
              />
            ))}
          </div>
        )}
        {/* Right chevron */}
        <Button
          type="text"
          size="small"
          icon={<ChevronRight />}
          disabled={!canAdvance || isLast}
          onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
        />

        <div style={{ flex: 1 }} />

        {/* Right cluster: primary action. */}
        {payload.kind === "tool_approval" ? (
          <ToolApprovalActions
            answered={!!approvals[current.question_id]}
            approval={approvals[current.question_id]}
            sessionAllowed={sessionAllowed}
            isLast={isLast}
            onSet={(a) => setApprovals((p) => ({ ...p, [current.question_id]: a }))}
            onNext={() => setPage((p) => Math.min(total - 1, p + 1))}
            onSubmitAll={submitAll}
          />
        ) : isLast ? (
          <Button
            size="small"
            type="primary"
            icon={<Check />}
            disabled={!canAdvance}
            onClick={() => submitAll()}
          >
            提交
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            disabled={!canAdvance}
            onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
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
      case "discussion":
        return { icon: <MessageSquare />, label: "方案选择", color: "var(--color-info-500)" };
      case "clarify":
        return { icon: <CircleHelp />, label: "需要澄清", color: "var(--main-500)" };
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
  sessionAllowed,
}: BodyProps & { header: React.ReactNode }) {
  const actionReq = q.context?.actionRequests?.[0];
  const toolName = q.context?.source ?? q.header ?? "工具";
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
      {/* Only show the question text if it adds info beyond the tool name. */}
      {q.question && q.question !== `批准执行: ${toolName}?` && header}
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
    </div>
  );
}

/**
 * tool_approval action cluster (rendered in the footer's right slot). Shows
 * reject / approve pills; on the last page they submit the full set, on
 * earlier pages they record + auto-advance.
 */
function ToolApprovalActions({
  answered,
  approval,
  sessionAllowed,
  isLast,
  onSet,
  onNext,
  onSubmitAll,
}: {
  answered: boolean;
  approval?: Approval;
  sessionAllowed: boolean;
  isLast: boolean;
  onSet: (a: Approval) => void;
  onNext: () => void;
  onSubmitAll: (meta?: { approveForSession?: boolean }) => void;
}) {
  // For tool_approval the decision buttons ARE the per-question answer —
  // tapping one records it, then advances (mid-pages) or submits (last page).
  const decide = (a: Approval) => {
    onSet(a);
    if (isLast) onSubmitAll();
    else onNext();
  };
  return (
    <>
      <Button size="small" danger onClick={() => decide({ type: "reject" })}>
        拒绝
      </Button>
      <Button
        size="small"
        type="primary"
        icon={<Check />}
        onClick={() => decide({ type: "approve" })}
      >
        批准
      </Button>
      {!sessionAllowed && isLast && (
        <Tooltip title="本次会话内对该工具自动批准（刷新失效）">
          <Button size="small" onClick={() => onSubmitAll({ approveForSession: true })}>
            本次会话都批准
          </Button>
        </Tooltip>
      )}
    </>
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
      {q.allow_other && (
        <TextArea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="其他…（自由输入）"
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

type Approval = { type: "approve" | "reject" };

/** Build a short human-readable summary of a resolved AskEvent. */
export function summarizeResolution(
  kind: AskKind,
  questions: AskQuestion[],
  resolution?: ResumeRequestBody,
): string {
  if (!resolution) return "等待回答…";
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
