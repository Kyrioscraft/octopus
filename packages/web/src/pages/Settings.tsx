import { OctopusClient } from "@octopus/tentacle";
import { GeneralSettingsSection } from "../components/settings/GeneralSettingsSection.js";
import { ModelSettingsSection } from "../components/settings/ModelSettingsSection.js";
import { PageHeader } from "../components/shared/PageHeader.js";

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
      <PageHeader title={TAB_TITLES[tab]} />

      {/* Scrollable content */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px 20px 48px" }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
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
