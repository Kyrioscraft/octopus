import { useState, useEffect, useCallback } from "react";
import { Switch, Spin, message as antdMessage, Tag, Button, Segmented } from "antd";
import {
  CodeXml,
  Globe,
  Plug,
  ClipboardCheck,
  CircleCheck,
  LogOut,
  Palette,
  BrainCircuit,
  ListChecks,
} from "lucide-react";
import type { OctopusClient, GeneralSettingsResponse, User } from "@octopus/tentacle";
import { SandboxSettingsSection } from "./SandboxSettingsSection.js";
import { SettingsCard as Card } from "../shared/SettingsCard.js";
import { useThemeStore } from "../../stores/theme.js";
import type { ThemeMode } from "../../stores/theme.js";
import { useDisplaySettingsStore } from "../../stores/display.js";

interface Props {
  sdk: OctopusClient;
}

type ToolKey = "enableShell" | "enableWebSearch" | "interactive" | "autoApprove";

const TOOL_FIELDS: {
  key: ToolKey;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  { key: "enableShell", label: "Shell 执行", description: "允许智能体执行 Shell 命令", icon: <CodeXml /> },
  { key: "enableWebSearch", label: "网页搜索", description: "允许智能体进行网页搜索", icon: <Globe /> },
  { key: "interactive", label: "交互确认", description: "需要人工确认危险操作 (HITL)", icon: <ClipboardCheck /> },
  { key: "autoApprove", label: "自动批准", description: "自动批准所有操作（覆盖交互确认）", icon: <CircleCheck /> },
];

/**
 * General settings section: tool toggles + account/system info.
 *
 * Tool toggles persist user intent to config.json (`settings.tools`); the
 * displayed value is the *effective* one (env var wins over config). Toggling
 * writes the persisted value and refreshes.
 */
export function GeneralSettingsSection({ sdk }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<GeneralSettingsResponse | null>(null);
  const [me, setMe] = useState<User | null>(null);
  // Theme is pure client-side (no backend round-trip); read/write the store.
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, user] = await Promise.all([
        sdk.getGeneralSettings(),
        sdk.getMe().catch(() => null),
      ]);
      setData(settings);
      setMe(user);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sdk]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (key: ToolKey, value: boolean) => {
    if (!data) return;
    // optimistic update of the effective display
    setData({
      ...data,
      effective: { ...data.effective, [key]: value },
      tools: { ...data.tools, [key]: value },
    });
    setSaving(true);
    try {
      const updated = await sdk.updateGeneralSettings({ [key]: value });
      setData(updated);
      antdMessage.success("已保存");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
      load();
    } finally {
      setSaving(false);
    }
  };

  const logout = () => {
    // No auth UI in dev (auto-init superadmin). Clear any cached token + return to chat.
    sdk.setToken("");
    window.location.href = "/";
  };

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <AppearanceCard mode={themeMode} onChange={setThemeMode} />
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <AppearanceCard mode={themeMode} onChange={setThemeMode} />
        <div style={{ color: "var(--gray-500)", padding: 40, textAlign: "center" }}>加载失败</div>
      </div>
    );
  }

  const envLocked = (key: ToolKey): boolean => {
    // Effective differs from persisted only when an env var is overriding.
    const eff = data.effective[key];
    const persisted = data.tools[key];
    return persisted !== undefined && eff !== persisted;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Appearance — theme mode picker (pure client-side, instant apply) */}
      <AppearanceCard mode={themeMode} onChange={setThemeMode} />

      {/* Tool toggles */}
      <Card title="工具开关">
        <div className="settings-rows">
          {TOOL_FIELDS.map((f) => {
            const checked = data.effective[f.key] ?? false;
            return (
              <div key={f.key} className="settings-row">
                <span style={{ fontSize: 18, color: "var(--main-color)", width: 24, textAlign: "center" }}>
                  {f.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--gray-1000)" }}>
                    {f.label}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--gray-500)" }}>{f.description}</div>
                </div>
                {envLocked(f.key) && (
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>环境变量覆盖</Tag>
                )}
                <Switch
                  size="small"
                  checked={checked}
                  disabled={saving}
                  onChange={(v) => toggle(f.key, v)}
                />
              </div>
            );
          })}
        </div>
      </Card>

      {/* Sandbox configuration */}
      <SandboxSettingsSection sdk={sdk} />

      {/* Account */}
      <Card title="账户">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 40, height: 40, borderRadius: "50%",
              background: "var(--bg-muted)",
              border: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "center", justifyContent: "center",
              fontSize: 16, color: "var(--text-secondary)", fontWeight: 600,
            }}
          >
            {(me?.username ?? "O").charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--gray-1000)" }}>
              {me?.username ?? "octopus"}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              角色：{me?.role ?? "superadmin"}
            </div>
          </div>
          <Button
            icon={<LogOut />}
            onClick={logout}
            style={{ borderRadius: 8 }}
          >
            退出登录
          </Button>
        </div>
      </Card>

      {/* System info */}
      <Card title="系统信息">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 24px" }}>
          <InfoRow label="配置文件路径" value={data.system_info.configPath} mono />
          <InfoRow label="默认模型" value={data.system_info.defaultModel ?? "（未设置）"} mono />
          <InfoRow label="供应商数量" value={String(data.system_info.providersCount)} />
          <InfoRow label="Node 版本" value={data.system_info.nodeVersion} />
          <InfoRow label="运行平台" value={data.system_info.platform} />
        </div>
      </Card>
    </div>
  );
}

/**
 * Theme mode picker. Extracted so it can render in the loading / error
 * branches too — theme switching is pure client-side and shouldn't be
 * blocked by backend settings fetch failures.
 */
function AppearanceCard({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (m: ThemeMode) => void;
}) {
  // Pure client-side display preference (messageStreamShowReasoning 语义).
  const showFullReasoning = useDisplaySettingsStore((s) => s.showFullReasoning);
  const setShowFullReasoning = useDisplaySettingsStore((s) => s.setShowFullReasoning);
  const autoCollapseTrace = useDisplaySettingsStore((s) => s.autoCollapseTrace);
  const setAutoCollapseTrace = useDisplaySettingsStore((s) => s.setAutoCollapseTrace);
  return (
    <Card title="外观">
      <div className="settings-rows">
        <div className="settings-row">
          <span className="settings-row-icon"><Palette /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--text-base)", fontWeight: 500, color: "var(--gray-1000)" }}>
              主题模式
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              选择界面配色，或跟随系统
            </div>
          </div>
          <Segmented<ThemeMode>
            size="small"
            value={mode}
            onChange={(v) => onChange(v)}
            options={[
              { label: "浅色", value: "light" },
              { label: "深色", value: "dark" },
              { label: "系统", value: "system" },
            ]}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-icon"><BrainCircuit /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--text-base)", fontWeight: 500, color: "var(--gray-1000)" }}>
              展示完整思考内容
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              在消息流中展示完整的模型思考内容；关闭时每轮仍展示第一次思考
            </div>
          </div>
          <Switch
            size="small"
            checked={showFullReasoning}
            onChange={(v) => setShowFullReasoning(v)}
          />
        </div>
        <div className="settings-row">
          <span className="settings-row-icon"><ListChecks /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--text-base)", fontWeight: 500, color: "var(--gray-1000)" }}>
              完成后折叠执行过程
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
              智能体工作时展开工具调用与思考，结束时收成一行「已完成 · N 步」摘要
            </div>
          </div>
          <Switch
            size="small"
            checked={autoCollapseTrace}
            onChange={(v) => setAutoCollapseTrace(v)}
          />
        </div>
      </div>
    </Card>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13 }}>
      <span style={{ color: "var(--gray-500)", flexShrink: 0 }}>{label}：</span>
      <span
        style={{
          color: "var(--gray-800)",
          wordBreak: "break-all",
          fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}
