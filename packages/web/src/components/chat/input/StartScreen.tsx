import type { ReactNode } from "react";
import { CodeXml, BookOpen, Bug, FileSearch } from "lucide-react";

/**
 * The start screen — shown when there are no messages (a fresh conversation).
 *
 * Centered layout: the Octopus mark, a random greeting, the composer (passed in
 * as a slot so this component doesn't need to know about input state), a grid of
 * suggestion cards, and a small disclaimer.
 *
 * `inputArea` is a render slot: the parent decides whether to show the normal
 * input bar or the AskPanel (when an ask_user_question interrupt is active).
 * `onPickExample` fires when a suggestion card is clicked.
 */
const SUGGESTIONS: { icon: ReactNode; title: string; hint: string; prompt: string }[] = [
  {
    icon: <CodeXml />,
    title: "写一个脚本",
    hint: "从零生成可运行的代码",
    prompt: "帮我写一个 Python 脚本",
  },
  {
    icon: <BookOpen />,
    title: "解释一个概念",
    hint: "用例子讲清技术原理",
    prompt: "解释一下什么是 LangGraph",
  },
  {
    icon: <Bug />,
    title: "分析并优化代码",
    hint: "找出问题并给出改法",
    prompt: "帮我分析和优化这段代码",
  },
  {
    icon: <FileSearch />,
    title: "读懂一个目录",
    hint: "梳理工作区的结构与职责",
    prompt: "帮我梳理当前工作区的目录结构",
  },
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
      // Fill the scroll container and center content with flex/box so the layout
      // adapts to whatever width the parent gives us (it shrinks when the
      // companion panel opens).
      minHeight: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "6vh 24px 40px",
      maxWidth: "var(--content-max)",
      width: "100%",
      margin: "0 auto",
      textAlign: "center",
    }}>
      <div style={{ animation: "fadeInUp var(--dur-3) var(--ease-out)", width: "100%" }}>
        <img
          src="/octopus-logo.svg"
          alt="Octopus"
          style={{ width: 56, height: 56, marginBottom: 18 }}
        />
        <h1 style={{
          fontSize: "var(--text-xl)", fontWeight: 600, letterSpacing: "-0.02em",
          color: "var(--gray-1000)",
          marginBottom: 28, lineHeight: 1.35,
        }}>
          {greeting}
        </h1>
        {inputArea}

        {/* Suggestion cards — the modern agent empty state. A 2x2 grid, so each
            card has room for its hint on one line at the 760px column. */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 8,
          marginTop: 18,
          textAlign: "left",
        }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="focus-ring suggestion-card"
              onClick={() => onPickExample(s.prompt)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "12px 14px",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-lg)",
                boxShadow: "var(--shadow-xs)",
                transition:
                  "border-color var(--dur-2) var(--ease), transform var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease)",
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "var(--radius-xs)",
                  background: "var(--bg-muted)",
                  color: "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                {s.icon}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)" }}>
                  {s.title}
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", lineHeight: 1.45 }}>
                  {s.hint}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div style={{ textAlign: "center", marginTop: 22 }}>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-tertiary)" }}>
            Octopus Agent · 请注意辨别内容的可靠性
          </span>
        </div>
      </div>
    </div>
  );
}