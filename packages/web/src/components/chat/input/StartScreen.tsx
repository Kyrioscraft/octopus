import type { ReactNode } from "react";

/**
 * The start screen — shown when there are no messages (a fresh conversation).
 *
 * Centered layout: the Octopus logo, a random greeting, the input area (passed
 * in as a slot so this component doesn't need to know about input state), a row
 * of example question chips, and a small disclaimer.
 *
 * `inputArea` is a render slot: the parent decides whether to show the normal
 * input bar or the AskPanel (when an ask_user_question interrupt is active).
 * `onPickExample` fires when an example chip is clicked.
 */
const EXAMPLE_QUESTIONS = [
  "帮我写一个 Python 脚本",
  "解释一下什么是 LangGraph",
  "帮我分析和优化这段代码",
];

export function StartScreen({
  greeting,
  inputArea,
  onPickExample,
}: {
  greeting: string;
  inputArea: ReactNode;
  onPickExample: (q: string) => void;
}) {
  return (
    <div style={{
      // Fill the scroll container and center content with fl/box so the layout
      // adapts to whatever width the parent gives us (it shrinks when the
      // companion panel opens). The previous absolute + left:50% positioned
      // against the page root, which ignored the column and got covered by the
      // companion panel.
      minHeight: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "8vh 20px",
      maxWidth: 800,
      width: "100%",
      margin: "0 auto",
      textAlign: "center",
    }}>
      <div style={{ animation: "fadeInUp 0.4s ease-out", width: "100%" }}>
        <img
          src="/octopus-logo.svg"
          alt="Octopus"
          style={{
            width: 72, height: 72, marginBottom: 20,
            filter: "drop-shadow(0 4px 12px rgba(35,120,4,0.12))",
          }}
        />
        <h1 style={{
          fontSize: "1.4rem", fontWeight: 600, color: "var(--gray-1000)",
          marginBottom: 32, lineHeight: 1.4,
        }}>
          {greeting}
        </h1>
        {inputArea}
        <div style={{
          display: "flex", gap: 8, flexWrap: "wrap",
          justifyContent: "center", marginTop: 16,
        }}>
          {EXAMPLE_QUESTIONS.map((q, i) => (
            <div
              key={i}
              onClick={() => onPickExample(q)}
              style={{
                padding: "6px 12px", background: "var(--gray-25)",
                borderRadius: 16, cursor: "pointer",
                fontSize: "0.8rem", color: "var(--gray-700)",
                whiteSpace: "nowrap", border: "1px solid transparent",
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--main-200)";
                e.currentTarget.style.color = "var(--main-700)";
                e.currentTarget.style.boxShadow = "0 0 4px rgba(0,0,0,0.03)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "transparent";
                e.currentTarget.style.color = "var(--gray-700)";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              {q}
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <span style={{ fontSize: 12, color: "var(--gray-300)" }}>
            Octopus Agent · 请注意辨别内容的可靠性
          </span>
        </div>
      </div>
    </div>
  );
}
