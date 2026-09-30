import { PanelRightClose, PanelRightOpen, Sun, Moon } from "lucide-react";
import { GithubIcon } from "../widgets/GithubIcon.js";
import { IconButton } from "../widgets/IconButton.js";
import { TodoBadge } from "./header/TodoBadge.js";
import { SubagentBadge } from "./header/SubagentBadge.js";
import { useThemeStore } from "../../stores/theme.js";
import type { TodoItem } from "./companion/types.js";
import type { SubagentEvent } from "./turn/types.js";

/**
 * Chat page header — a slim bar above the conversation body.
 *
 * Left side: the conversation title ("新对话" when empty, "对话" otherwise).
 * Right side: on-demand status badges (todos / subagents, rendered only when the
 * conversation has any), the companion-panel toggle, a theme toggle, and a GitHub
 * link. All actions are the same 32px `.icon-btn` so the bar reads as one row of
 * controls; only the companion toggle carries an "on" state, and it uses the soft
 * accent rather than antd's filled primary (a solid green block in the header
 * competes with the composer's send button).
 *
 * Purely presentational apart from the theme toggle — all other state
 * (`companionOpen`) and handlers (`onToggleCompanion`) come via props.
 */
export function ChatHeader({
  showStart,
  companionOpen,
  onToggleCompanion,
  todos,
  subagents,
}: {
  showStart: boolean;
  companionOpen: boolean;
  onToggleCompanion: () => void;
  todos: TodoItem[];
  subagents: SubagentEvent[];
}) {
  const resolved = useThemeStore((s) => s.resolved);
  const setMode = useThemeStore((s) => s.setMode);
  const isDark = resolved === "dark";

  return (
    <div style={{
      height: "var(--header-h)",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 12px 0 20px",
      borderBottom: "1px solid var(--border-subtle)",
      background: "var(--bg-canvas)",
      flexShrink: 0,
      gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{
          fontWeight: 600, fontSize: "var(--text-base)", letterSpacing: "-0.01em",
          color: "var(--gray-1000)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {showStart ? "新对话" : "对话"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {/* On-demand status badges — only render when the conversation has any.
            Both open the right-side companion panel at the matching tab. */}
        <TodoBadge todos={todos} />
        <SubagentBadge subagents={subagents} />

        {/* Companion panel toggle — opens/closes the right-side panel (the app's
            shared secondary surface hosting files / subagents / todos tabs).
            The panel's own tab bar handles switching; this button only toggles. */}
        <IconButton
          icon={companionOpen ? <PanelRightClose /> : <PanelRightOpen />}
          title={companionOpen ? "收起伴侣面板" : "打开伴侣面板"}
          active={companionOpen}
          onClick={onToggleCompanion}
        />
        <IconButton
          icon={isDark ? <Sun /> : <Moon />}
          title={isDark ? "切换到浅色主题" : "切换到深色主题"}
          onClick={() => setMode(isDark ? "light" : "dark")}
        />
        <IconButton
          icon={<GithubIcon size={16} />}
          title="GitHub 仓库"
          href="https://github.com/kyrioscraft/octopus"
          target="_blank"
        />
      </div>
    </div>
  );
}