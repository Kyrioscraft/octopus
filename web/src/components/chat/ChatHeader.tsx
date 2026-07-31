import { Button, Tooltip } from "antd";
import { GithubOutlined, LeftSquareOutlined, RightSquareOutlined } from "@ant-design/icons";

/**
 * Chat page header — a slim bar (45px) above the conversation body.
 *
 * Left side: the conversation title ("新对话" when empty, "对话" otherwise).
 * Right side: the companion-panel toggle (open/close the right-side panel) and
 * a GitHub repo link.
 *
 * Purely presentational — all state (`companionOpen`) and handlers
 * (`onToggleCompanion`) come via props. The component owns no state of its own.
 */
export function ChatHeader({
  showStart,
  companionOpen,
  onToggleCompanion,
}: {
  showStart: boolean;
  companionOpen: boolean;
  onToggleCompanion: () => void;
}) {
  return (
    <div style={{
      height: 45, display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 20px", borderBottom: "1px solid var(--gray-150)", flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--gray-1000)" }}>
          {showStart ? "新对话" : "对话"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {/* Companion panel toggle — opens/closes the right-side panel (the app's
            shared secondary surface hosting files / subagents / todos tabs).
            The panel's own tab bar handles switching; this button only toggles. */}
        <Tooltip title={companionOpen ? "收起伴侣面板" : "打开伴侣面板"}>
          <Button
            type={companionOpen ? "primary" : "text"}
            size="small"
            onClick={onToggleCompanion}
            style={{
              height: 28, borderRadius: 6, padding: "0 8px",
              fontSize: 13, flexShrink: 0,
              display: "flex", alignItems: "center", gap: 4,
            }}
            className="hover-green"
          >
            {companionOpen
              ? <LeftSquareOutlined style={{ fontSize: 15 }} />
              : <RightSquareOutlined style={{ fontSize: 15 }} />}
          </Button>
        </Tooltip>
        <Tooltip title="GitHub 仓库">
          <a
            href="https://github.com/kyrioscraft/octopus"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 6,
              color: "var(--gray-600)", transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--main-color)";
              e.currentTarget.style.background = "var(--main-20)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--gray-600)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <GithubOutlined style={{ fontSize: 16 }} />
          </a>
        </Tooltip>
      </div>
    </div>
  );
}
