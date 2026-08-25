/**
 * `ask_user_question` — agent-initiated question to the user.
 *
 * Unlike LangChain's `humanInTheLoopMiddleware` (passive tool-call approval),
 * this tool lets the agent *actively* interrupt the graph to ask the user a
 * question — for plan/option discussion, requirement clarification, or any
 * other moment where guessing would be worse than asking.
 *
 * Mechanism: the tool body calls langgraph's `interrupt({ kind, questions })`.
 * The interrupt value flows to the server's `buildAskPayload`, which emits an
 * `ask_user_question_required` chunk. The client renders the input-area
 * AskPanel; on submit it sends a `ResumeRequestBody` whose `answers` are
 * passed back here as the `interrupt()` return value. The tool then returns
 * the answers as a JSON string ToolMessage so the model can act on them.
 *
 * `kind` is derived: questions without `options` → "clarify" (free text),
 * otherwise "discussion" (selectable options).
 *
 * Equivalent to OpenAI Agents SDK's `AskUserQuestion` (Python), ported to the
 * LangChain + langgraph interrupt primitive.
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";

/** One option the user can pick. */
const QuestionOptionSchema = z.object({
  label: z.string().optional().describe("Short human-readable label for the option."),
  value: z.string().optional().describe(
    "Stable machine value returned to the agent on selection. Defaults to label if omitted.",
  ),
  description: z.string().optional().describe("Optional helper text shown beneath the label."),
});

/** A single question posed to the user. */
const AskQuestionSchema = z.object({
  question: z.string().describe("The complete question text."),
  header: z.string().optional().describe("Short label for the header chip (truncated to 12 chars)."),
  options: z.array(QuestionOptionSchema).optional().describe(
    "Selectable options. Omit for a free-text (clarify) question.",
  ),
  multi_select: z.boolean().optional().describe("Allow multiple selections. Defaults to false."),
  allow_other: z.boolean().optional().describe(
    'Show an "Other…" free-text input alongside the options. Defaults to false.',
  ),
});

/** Top-level tool input schema. */
const AskUserQuestionInputSchema = z.object({
  questions: z.array(AskQuestionSchema).min(1).describe(
    "One or more questions. Each gets its own row in the input-area AskPanel.",
  ),
});

/** Resume value returned by `interrupt()` — the user's answers. */
export interface AskUserQuestionResume {
  kind: "discussion" | "clarify";
  questions: Array<{
    question_id: string;
    question: string;
    header?: string;
    options?: Array<{ label: string; value: string; description?: string }>;
    multi_select?: boolean;
    allow_other?: boolean;
  }>;
}

/** User-supplied answer (mirrors tentacle ResumeRequestBody.answers[*]). */
export interface AskUserQuestionAnswer {
  question_id: string;
  /** Single value (radio) or values (checkbox). */
  selection?: string | string[];
  /** Free-text — clarify answer, or the "Other…" supplement when allow_other. */
  text?: string;
}

/**
 * Build the `ask_user_question` tool. Tags each question with a stable
 * `question_id` (so the client can pair answers back), derives `kind`, calls
 * `interrupt()`, and returns the answers as JSON for the model.
 */
export function createAskUserQuestionTool() {
  return tool(
    async (input) => {
      const kind: AskUserQuestionResume["kind"] = input.questions.every((q) => !q.options)
        ? "clarify"
        : "discussion";
      // Tag stable ids at the source — the server reads these from
      // interrupt.value instead of regenerating uuid() per emit, so answers
      // can be paired back across interrupt → resume.
      const tagged: AskUserQuestionResume = {
        kind,
        questions: input.questions.map((q, i) => ({
          question_id: `ask_${Date.now()}_${i}`,
          question: q.question,
          ...(q.header ? { header: q.header.slice(0, 12) } : {}),
          // LLMs often omit `value` (label-only options) — fall back to the
          // label so zod validation upstream never rejects the call, and the
          // downstream AskPanel/buildAskPayload always see both fields.
          ...(q.options
            ? {
                options: q.options
                  .filter((o) => (o.label ?? o.value) != null)
                  .map((o) => ({
                  label: o.label ?? o.value!,
                  value: o.value ?? o.label!,
                  ...(o.description ? { description: o.description } : {}),
                })),
              }
            : {}),
          ...(q.multi_select ? { multi_select: q.multi_select } : {}),
          ...(q.allow_other ? { allow_other: q.allow_other } : {}),
        })),
      };
      // The interrupt value is consumed by buildAskPayload server-side; the
      // return value (when resumed) is the user's answers array. langgraph's
      // interrupt() returns `any`, so we cast.
      const answers = interrupt<AskUserQuestionResume, AskUserQuestionAnswer[]>(tagged);
      return JSON.stringify(answers);
    },
    {
      name: "ask_user_question",
      description: [
        "Ask the user a question and WAIT for their answer before continuing.",
        "",
        "You MUST call this tool (rather than writing the question as plain text)",
        "whenever you need input only the user can provide. The user answers via a",
        "dedicated UI, so calling this tool is the only way to actually pause and",
        "collect a decision — a plain-text question will NOT pause the conversation.",
        "",
        "Call this tool when ANY of these apply:",
        "- Choosing between approaches, technologies, or design options (e.g.",
        "  React vs Vue, REST vs GraphQL, which library to use).",
        "- The request is ambiguous and the answer materially changes your work",
        "  (scope, target stack, data format, success criteria).",
        "- You are about to make an irreversible or high-impact decision and the",
        "  user's preference is unknown.",
        "- You need a confirmation that is more consequential than a simple yes/no",
        "  approval handled by the tool-call review.",
        "",
        "Do NOT call it for: yes/no approvals already handled by tool review;",
        "questions you can answer by reading the codebase; or trivial clarifications",
        "you can reasonably assume.",
        "",
        "Schema guidance: omit `options` for a free-text clarification; provide",
        "`options` (2-4, concise) for a selection — each option only needs a",
        "`label` (plus optional `description`); `value` may be omitted. Use",
        "`allow_other` when the user might pick something you didn't list.",
      ].join("\n"),
      schema: AskUserQuestionInputSchema,
    },
  );
}
