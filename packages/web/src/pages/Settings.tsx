import { OctopusClient } from "@octopus/tentacle";
import { GeneralSettingsSection } from "../components/settings/GeneralSettingsSection.js";
import { ModelSettingsSection } from "../components/settings/ModelSettingsSection.js";

const sdk = new OctopusClient();

export type SettingsTab = "general" | "model";

const TAB_TITLES: Record<SettingsTab, string> = {
  general: "常规",
  model: "模型配置",
};

interface SettingsPageProps {
  tab: SettingsTab;
}

/**
 * Settings page (single tab). Tab is driven by the route; SettingsSidebar
 * handles navigation between 常规 and 模型配置. Mirrors the ExtensionsPage
 * layout: titled header + scrollable content.
 */
export function SettingsPage({ tab }: SettingsPageProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          height: 45,
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          borderBottom: "1px solid var(--gray-150)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--gray-1000)" }}>
          {TAB_TITLES[tab]}
        </span>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          {tab === "general" ? (
            <GeneralSettingsSection sdk={sdk} />
          ) : (
            <ModelSettingsSection sdk={sdk} />
          )}
        </div>
      </div>
    </div>
  );
}
