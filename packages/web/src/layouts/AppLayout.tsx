import { Outlet, useLocation } from "react-router-dom";
import { Layout } from "antd";
import { Sidebar } from "../components/sidebars/Sidebar.js";
import { ExtensionsSidebar } from "../components/sidebars/ExtensionsSidebar.js";
import { SettingsSidebar } from "../components/sidebars/SettingsSidebar.js";
import { ImageLightbox } from "../components/widgets/ImageLightbox.js";
import { useUiStore } from "../stores/ui.js";
import "../styles/theme.css";
import "../styles/markdown.css";

const { Sider, Content } = Layout;

/**
 * App shell.
 *
 * The window backdrop (`--bg-app`) carries the sidebar **and** the gutter around the
 * content, and the content region floats on it as a single card: one border, a small
 * radius, one soft shadow. Everything inside the card (chat header, transcript,
 * composer, settings sections) is a flat region of that card rather than another
 * card — nested elevation would read as card-in-card. In light mode the backdrop is
 * a whisper lighter than the card; in dark it is a step deeper, so the card reads as
 * raised either way.
 */
export function AppLayout() {
  const location = useLocation();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  const isSettings = location.pathname.startsWith("/settings");
  const isExtensions = location.pathname.startsWith("/extensions");

  const sidebar = isSettings ? (
    <SettingsSidebar collapsed={collapsed} />
  ) : isExtensions ? (
    <ExtensionsSidebar collapsed={collapsed} />
  ) : (
    <Sidebar collapsed={collapsed} />
  );

  const width = collapsed ? 60 : 252;

  return (
    <Layout style={{ height: "100vh", background: "var(--bg-app)" }} hasSider>
      <Sider
        width={width}
        style={{
          // Sits directly on the backdrop: no fill, no divider — the card's own
          // edge is what separates chrome from content.
          background: "transparent",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          // antd sets `flex: 0 0 <width>`; animate the parts of that shorthand so
          // collapsing/expanding eases instead of snapping.
          flex: `0 0 ${width}px`,
          maxWidth: width,
          minWidth: width,
          transition:
            "flex-basis var(--dur-3) var(--ease-out), max-width var(--dur-3) var(--ease-out), min-width var(--dur-3) var(--ease-out)",
        }}
      >
        {sidebar}
      </Sider>
      <Content
        style={{
          flex: 1,
          minWidth: 0,
          // The card: a tight inset from the backdrop on all sides. Only 4px
          // vertically, so the shadow is kept to `shadow-xs` (3px extent) — a
          // larger one would be clipped by the layout edge.
          margin: "4px 8px",
          background: "var(--bg-canvas)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-sm)",
          boxShadow: "var(--shadow-xs)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Outlet />
      </Content>
      {/*
        The right-side secondary surface (workspace files / subagents / todos)
        is the generic Companion panel (components/chat/companion), rendered inside
        ChatPage (it needs message-derived data).
      */}

      {/* One global image viewer for every thumbnail in the app. */}
      <ImageLightbox />
    </Layout>
  );
}