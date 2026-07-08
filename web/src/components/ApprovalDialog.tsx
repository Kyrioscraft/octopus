interface Props {
  questions: Array<{ question: string }>;
  onApprove: () => void;
  onReject: () => void;
}

export function ApprovalDialog({ questions, onApprove, onReject }: Props) {
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.3)",
      display: "flex", justifyContent: "center", alignItems: "center",
      zIndex: 1000,
      animation: "fadeInUp 0.2s ease-out",
    }}>
      <div style={{
        background: "var(--gray-0)", borderRadius: 16,
        padding: 24, width: 420,
        boxShadow: "0 8px 24px var(--shadow-2), 0 2px 8px var(--shadow-1)",
      }}>
        <h3 style={{
          margin: 0, marginBottom: 16, fontSize: 16, fontWeight: 600,
          color: "#faad14",
        }}>
          需要批准
        </h3>
        {questions.map((q, i) => (
          <div key={i} style={{
            fontSize: 14, color: "var(--gray-700)", marginBottom: 10,
            fontFamily: "monospace", background: "var(--gray-25)",
            padding: "10px 14px", borderRadius: 8,
            border: "1px solid var(--gray-150)",
            wordBreak: "break-all", lineHeight: 1.5,
          }}>
            {q.question}
          </div>
        ))}
        <div style={{
          display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20,
        }}>
          <button
            onClick={onApprove}
            style={{
              padding: "8px 24px", borderRadius: 8,
              background: "var(--main-600)", color: "var(--gray-0)",
              border: "none", fontSize: 14, fontWeight: 500, cursor: "pointer",
              transition: "background-color 0.2s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--main-700)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--main-600)"; }}
          >
            批准
          </button>
          <button
            onClick={onReject}
            style={{
              padding: "8px 24px", borderRadius: 8,
              background: "var(--gray-0)", color: "var(--color-error-500)",
              border: "1px solid var(--color-error-100)",
              fontSize: 14, fontWeight: 500, cursor: "pointer",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-error-50)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--gray-0)";
            }}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
