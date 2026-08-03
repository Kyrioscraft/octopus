import { useCallback, useEffect, useRef, useState } from "react";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { X, Plus } from "lucide-react";
import { useChatStore } from "../../../stores/chat.js";
import type { CompanionTabEntry, CompanionTabKind } from "../../../stores/chat.js";
import { TAB_META, type CompanionPanelProps } from "./types.js";
import { FilesPanel } from "./panels/FilesPanel.js";
import { SubagentPanel } from "./panels/SubagentPanel.js";
import { TodoPanel } from "./panels/TodoPanel.js";

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
 * Generic in-conversation companion panel — the app's shared secondary surface.
 *
 * Lives BELOW the chat header, to the RIGHT of the message list (a flex sibling
 * inside the chat body). It occupies real layout space (not an overlay): when
 * open, it narrows the message list + input bar. Width is drag-adjustable and
 * persisted.
 *
 * Tabs are browser-style: each has a close (×) button; a "+" menu at the end of
 * the tab strip adds a new tab (文件 / 子智能体 / 待办). Multiple subagent tabs
 * can be open at once (one per run); files/todos are singletons.
 *
 * This component is purely a CONTAINER — it owns the tab strip + drag-resize +
 * panel routing. What renders inside a tab is decided by `PANELS` + the
 * per-panel component, keeping the container reusable for any future panels.
 *
 * State (open tabs, active tab, width) lives in `useChatStore` so any trigger
 * (header buttons, subagent chips, todo badge) can open the companion panel to a tab.
 */
export function Companion(props: CompanionPanelProps) {
  const open = useChatStore((s) => s.companionOpen);
  const tabs = useChatStore((s) => s.companionTabs);
  const activeId = useChatStore((s) => s.activeCompanionTabId);
  const setActive = useChatStore((s) => s.setActiveCompanionTab);
  const closeTab = useChatStore((s) => s.closeCompanionTab);
  const openTab = useChatStore((s) => s.openCompanionTab);
  const width = useChatStore((s) => s.companionWidth);

  // Width is driven by the sibling <CompanionDivider /> (industry-standard
  // independent divider, not an in-panel absolute handle). It writes directly
  // to the store, so this component just reads `width` — no local drag state.

  if (!open || tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  const ActivePanel = PANELS[activeTab.kind];

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

  return (
    <div
      style={{
        width: width,
        flexShrink: 0,
        background: "var(--gray-0)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Browser-style tab strip. */}
      <TabStrip
        tabs={tabs}
        activeId={activeTab.id}
        onSelect={setActive}
        onClose={closeTab}
        addMenuItems={addMenuItems}
      />

      {/* Active panel content. */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {ActivePanel && (
          <ActivePanel {...props} refId={activeTab.refId} />
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

  // Hidden when the panel is closed — no orphan line next to the message list.
  if (!open || tabs.length === 0) return null;

  const lineColor = dragging ? "var(--main-color)" : "var(--gray-200)";
  return (
    <div
      onMouseDown={onHandleDown}
      onMouseEnter={(e) => {
        if (!dragging) e.currentTarget.style.background = "var(--gray-100)";
      }}
      onMouseLeave={(e) => {
        if (!dragging) e.currentTarget.style.background = "transparent";
      }}
      style={{
        width: 6,
        flexShrink: 0,
        cursor: "col-resize",
        position: "relative",
        zIndex: 5,
        transition: "background 0.15s ease",
      }}
      title="拖拽调整宽度"
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
          background: dragging ? "var(--main-color)" : lineColor,
          transition: "background 0.15s ease",
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
}: {
  tabs: CompanionTabEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  addMenuItems: MenuProps["items"];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px 0",
        borderBottom: "1px solid var(--gray-150)",
        flexShrink: 0,
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => {
        const meta = TAB_META[t.kind];
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 28,
              padding: "0 6px 0 9px",
              fontSize: 12,
              borderRadius: "6px 6px 0 0",
              cursor: "pointer",
              whiteSpace: "nowrap",
              color: isActive ? "var(--gray-1000)" : "var(--gray-500)",
              background: isActive ? "var(--gray-0)" : "transparent",
              borderBottom: isActive ? "2px solid var(--main-color)" : "2px solid transparent",
              marginBottom: -1,
              userSelect: "none",
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
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: 4,
            color: "var(--gray-500)",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title="添加标签页"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--gray-100)";
            e.currentTarget.style.color = "var(--gray-700)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--gray-500)";
          }}
        >
          <Plus style={{ fontSize: 13 }} />
        </div>
      </Dropdown>
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
        borderRadius: 4,
        color: "var(--gray-400)",
        cursor: "pointer",
        transition: "all 0.12s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--gray-100)";
        e.currentTarget.style.color = "var(--gray-700)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--gray-400)";
      }}
      title="关闭标签页"
    >
      <X style={{ fontSize: 9 }} />
    </span>
  );
}
