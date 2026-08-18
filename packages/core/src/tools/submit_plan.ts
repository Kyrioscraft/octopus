/**
 * `submit_plan` — plan-mode approval gate (ZCode ExitPlanMode equivalent).
 *
 * In plan mode the agent researches read-only, then MUST submit its plan via
 * this tool before any execution can happen. The tool body calls langgraph's
 * `interrupt({ kind: "plan_approval", plan, ... })`; the interrupt value flows
 * to the server's `buildAskPayload`, which emits an `ask_user_question_required`
 * chunk with `kind: "plan_approval"`. The client renders the plan with
 * approve/reject controls; on submit it sends a `ResumeRequestBody` whose
 * `approved` / `feedback` fields are passed back here as the `interrupt()`
 * return value.
 *
 * On approval the server flips the thread's access mode to `confirm`, so the
 * resumed turn runs with the full (write-capable) toolset under per-tool HITL.
 * On rejection the user's feedback is returned so the model can revise the
 * plan and re-submit.
 *
 * Modeled after `ask_user_question.ts` (same interrupt → resume protocol).
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";

/** Top-level tool input schema. */
const SubmitPlanInputSchema = z.object({
  plan: z.string().min(1).describe(
    "The complete implementation plan in markdown. Include: root cause / " +
    "analysis, the concrete steps (files to change and how), and any " +
    "verification steps. This text is shown verbatim to the user for approval.",
  ),
});

/** Interrupt value consumed server-side by `buildAskPayload`. */
export interface PlanApprovalInterruptValue {
  kind: "plan_approval";
  plan: string;
}

/** Resume value returned by `interrupt()` — the user's verdict. */
export interface PlanApprovalResume {
  approved: boolean;
  /** Free-text revision feedback when rejected. */
  feedback?: string;
}

/**
 * Build the `submit_plan` tool. Only injected in plan mode (see
 * makeGraph step 3b) — calling it elsewhere is a no-op error string.
 */
export function createSubmitPlanTool() {
  return tool(
    async (input) => {
      const value: PlanApprovalInterruptValue = {
        kind: "plan_approval",
        plan: input.plan,
      };
      const verdict = interrupt<PlanApprovalInterruptValue, PlanApprovalResume>(value);
      if (verdict?.approved) {
        return (
          "PLAN APPROVED. The access mode has been switched to confirm. " +
          "Proceed to implement the plan now — write/edit tools are available " +
          "again and will ask for per-tool approval as usual."
        );
      }
      return (
        "PLAN REJECTED. The user provided the following feedback — revise the " +
        "plan accordingly (you may need to explore further) and call " +
        "submit_plan again with the updated plan:\n" +
        (verdict?.feedback?.trim() || "(no feedback provided)")
      );
    },
    {
      name: "submit_plan",
      description: [
        "Submit your implementation plan for user approval. This is the ONLY way",
        "to exit plan mode and start executing — you MUST call it once your",
        "read-only research is complete and you have a concrete plan.",
        "",
        "The user reviews the plan and either approves it (the session switches",
        "to confirm mode and you may implement) or rejects it with feedback",
        "(revise the plan and submit again).",
        "",
        "Before calling this tool, make sure any genuinely user-facing choices",
        "(approach A vs B, tech stack, scope) have already been resolved via",
        "ask_user_question — the plan you submit should be final.",
      ].join("\n"),
      schema: SubmitPlanInputSchema,
    },
  );
}
