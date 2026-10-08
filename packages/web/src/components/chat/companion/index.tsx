import { useCallback, useEffect, useRef, useState } from "react";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { X, Plus, PanelRightClose } from "lucide-react";
import { useChatStore } from "../../../stores/chat.js";
import type { CompanionTabEntry, CompanionTabKind } from "../../../stores/chat.js";
import { useCompanionData } from "../../../hooks/useCompanionData.js";
import { TAB_META, type CompanionPanelProps } from "./types.js";
import { FilesPanel } from "./panels/FilesPanel.js";
import { SubagentPanel } from "./panels/SubagentPanel.js";
import { TodoPanel } from "./panels/TodoPanel.js";
import { IconButton } from "../../widgets/IconButton.js";

/**
 * Panel registry — each tab kind maps to a single panel component. Adding a new
 * panel is a one-line change here (plus the panel file). The container stays
 * generic: it knows nothing about what a panel renders, only its kind.
 */
const PANELS: Record<CompanionTabKind, (props: CompanionPanelProps) => React.ReactNode> = {
  files: (p) => <FilesPanel {...p} />,
  subagents: (p) => <SubagentPanel {...p} />,
  todos: (p) => <TodoPanel {...p} />,
};

/**
 * The companion panel — the app's shared secondary surface, mounted at the
 * layout level as a sibling of the chat page (it has its own header, and the
 * chat header governs only the chat column).
 *
 * The root is a persistent "rail" that animates exactly like the left sidebar
 * (AppLayout's Sider): `flex-basis` + `max/min-width` transition between 0 and
 * `companionWidth` with the same duration/easing tokens. It renders
 * unconditionally — closing animates the rail to zero width rather than
 * unmounting, so open/close slides instead of popping. The inner content box
 * keeps the target width during the animation, so nothing reflows mid-slide.
 *
 * Tabs are browser-style: each has a close (×) button; a "+" menu adds a new
 * tab (文件 / 子智能体 / 待办); the header's right side carries the panel's own
 * collapse button. State (open tabs, active tab, width) lives in `useChatStore`
 * so any trigger (header buttons, subagent chips, todo badge) can open a tab.
 *
 * Data: todos/subagents are derived from `companionMsgs` — the message
 * projection `useChat` mirrors into the store (see useCompanionData).
 */
export function Companion() {
  const open = useChatStore((s) => s.companionOpen);
  const tabs = useChatStore((s) => s.companionTabs);
  const activeId = useChatStore((s) => s.activeCompanionTabId);
  const setActive = useChatStore((s) => s.setActiveCompanionTab);
  const closeTab = useChatStore((s) => s.closeCompanionTab);
  const openTab = useChatStore((s) => s.openCompanionTab);
  const setOpen = useChatStore((s) => s.setCompanionOpen);
  const width = useChatStore((s) => s.companionWidth);
  const { todos, subagents } = useCompanionData();

  const panelProps: CompanionPanelProps = { todos, subagents };

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  const ActivePanel = activeTab ? PANELS[activeTab.kind] : undefined;

  // "+" menu — the available kinds to add as a new tab.
  const addMenuItems: MenuProps["items"] = (
    Object.keys(PANELS) as CompanionTabKind[]
  ).map((kind) => ({
    key: kind,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {TAB_META[kind].icon}
        <span>{TAB_META[kind].label}</span>
      </span>
    ),
    onClick: () => openTab(kind),
  }));

  const hasContent = open && tabs.length > 0 && activeTab !== undefined;

  return (
    // The rail: always mounted, width animates 0 ⇄ companionWidth with the same
    // tokens as AppLayout's sidebar. Animated on `width` (not flex-basis): antd's
    // Layout stylesheet sets `flex` on layout children, and a shorthand-vs-inline
    // interaction swallowed the flex-basis animation in testing (computed stayed
    // 0px while the inline style said 420px).
    <div
      aria-hidden={!hasContent}
      style={{
        width: hasContent ? width : 0,
        flex: "none",
        flexShrink: 0,
        overflow: "hidden",
        transition:
          "width var(--dur-3) var(--ease-out)",
        // Zero width must mean zero footprint — no stray border/shadow pixels.
        borderLeft: hasContent ? "1px solid var(--border-subtle)" : "none",
      }}
    >
      {/* Content box renders at the FINAL width, clipped by the rail while the
          animation runs — no mid-slide text reflow. */}
      <div
        style={{
          width: width,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-canvas)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {hasContent && (
          <>
            {/* The panel's own header: tabs + this panel's collapse button. */}
            <TabStrip
              tabs={tabs}
              activeId={activeTab.id}
              onSelect={setActive}
              onClose={closeTab}
              addMenuItems={addMenuItems}
              onClosePanel={() => setOpen(false)}
            />

            {/* Active panel content. */}
            <div style={{ flex: 1, overflow: "hidden" }}>
              {ActivePanel && (
                <ActivePanel {...panelProps} refId={activeTab.refId} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Independent draggable divider — the industry-standard pattern (VS Code,
 * Chrome DevTools, etc.). It is a real flex child sitting BETWEEN the message
 * column and the companion panel, never an `absolute` element glued to an edge
 * (which the parent's `overflow: hidden` would clip — that was the previous bug).
 *
 * Hit area vs. visual area are deliberately separated: the element is 6px wide
 * (easy to grab), but the visible line inside it is only 1px (unobtrusive).
 * The line lights up on hover and during drag. While dragging, the cursor is
 * locked globally on <body> so fast mouse moves don't lose the grab.
 *
 * Width math: the divider sits on the LEFT edge of the panel, so dragging left
 * grows the panel (`startX - clientX` is positive when moving left) — same
 * direction as the legacy handle, logic ported verbatim.
 */
export function CompanionDivider() {
  const open = useChatStore((s) => s.companionOpen);
  const tabs = useChatStore((s) => s.companionTabs);
  const width = useChatStore((s) => s.companionWidth);
  const setWidth = useChatStore((s) => s.setCompanionWidth);
  const minW = useChatStore((s) => s.minCompanionWidth);
  const maxW = useChatStore((s) => s.maxCompanionWidth);

  const visible = open && tabs.length > 0;

  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onHandleDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
      // Global cursor + selection lock so the grab never drops mid-drag.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width],
  );

  // Listeners are bound while `dragging` is true. Keying the effect on
  // `dragging` (not on the ref) guarantees the window listeners attach exactly
  // when a drag starts and tear down when it ends — the previous version only
  // ran on mount/stable-selector changes, so the first drag never bound its
  // move/up handlers and the panel appeared un-draggable.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const st = dragState.current;
      if (!st) return;
      const next = st.startWidth + (st.startX - e.clientX);
      setWidth(Math.max(minW, Math.min(maxW, next)));
    };
    const onUp = () => {
      dragState.current = null;
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, setWidth, minW, maxW]);

  const lineColor = dragging ? "var(--accent-solid)" : "var(--border-subtle)";
  return (
    <div
      onMouseDown={visible ? onHandleDown : undefined}
      onMouseEnter={(e) => {
        if (!dragging) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!dragging) e.currentTarget.style.background = "transparent";
      }}
      style={{
        // Persistent: collapses to 0 alongside the panel rail (same transition),
        // so the divider slides out with the panel instead of popping away.
        width: visible ? 6 : 0,
        flexShrink: 0,
        overflow: "hidden",
        cursor: visible ? "col-resize" : "default",
        pointerEvents: visible ? "auto" : "none",
        position: "relative",
        zIndex: 5,
        transition:
          "width var(--dur-3) var(--ease-out), background var(--dur-1) var(--ease)",
      }}
      title={visible ? "拖拽调整宽度" : undefined}
    >
      {/* The 1px visible line, centered in the 6px hit area. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          transform: "translateX(-50%)",
          background: dragging ? "var(--accent-solid)" : lineColor,
          transition: "background var(--dur-1) var(--ease)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

/**
 * The browser-style tab strip: one chip per open tab (icon + label + × close),
 * plus a "+" dropdown to add a new tab. Pure presentational — all state/actions
 * come via props so the strip can be reasoned about in isolation.
 */
function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  addMenuItems,
  onClosePanel,
}: {
  tabs: CompanionTabEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  addMenuItems: MenuProps["items"];
  /** Collapse the whole panel (the companion header's own toggle). */
  onClosePanel: () => void;
}) {
  return (
    // Same height as the chat header (--header-h), so the two panels' headers
    // read as one aligned band across the content card.
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        height: "var(--header-h)",
        padding: "0 6px",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {tabs.map((t) => {
        const meta = TAB_META[t.kind];
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            className="focus-ring"
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(t.id);
              }
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 28,
              padding: "0 6px 0 9px",
              fontSize: "var(--text-xs)",
              borderRadius: "var(--radius-xs) var(--radius-xs) 0 0",
              cursor: "pointer",
              whiteSpace: "nowrap",
              color: isActive ? "var(--text-primary)" : "var(--text-tertiary)",
              background: isActive ? "var(--bg-subtle)" : "transparent",
              borderBottom: isActive ? "2px solid var(--accent-solid)" : "2px solid transparent",
              marginBottom: -1,
              userSelect: "none",
              transition: "background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease)",
            }}
          >
            <span style={{ display: "inline-flex", fontSize: 12 }}>{meta.icon}</span>
            <span>{meta.label}</span>
            <TabCloseButton onClose={() => onClose(t.id)} />
          </div>
        );
      })}
      {/* "+" add-tab menu. */}
      <Dropdown menu={{ items: addMenuItems }} trigger={["click"]} placement="bottomLeft">
        <button
          type="button"
          className="icon-btn focus-ring"
          title="添加标签页"
          aria-label="添加标签页"
          style={{ width: 26, height: 26, marginLeft: 2, marginBottom: 5 }}
        >
          <span style={{ display: "flex", fontSize: 14 }}>
            <Plus />
          </span>
        </button>
      </Dropdown>

      {/* The panel's own collapse control — the companion header is independent
          of the chat header, so it carries its own close affordance. */}
      <span style={{ flex: 1 }} />
      <IconButton
        icon={<PanelRightClose />}
        title="收起伴侣面板"
        size={26}
        iconSize={15}
        onClick={onClosePanel}
        // Bottom-align with the tabs (the header row itself is flex-end).
        style={{ marginBottom: 5 }}
      />
    </div>
  );
}

/** The × close affordance on each tab. */
function TabCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        borderRadius: "var(--radius-xs)",
        color: "var(--text-disabled)",
        cursor: "pointer",
        transition: "background-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-disabled)";
      }}
      title="关闭标签页"
    >
      <X style={{ fontSize: 9 }} />
    </span>
  );
}
