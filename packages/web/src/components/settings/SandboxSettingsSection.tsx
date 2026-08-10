import { useState, useEffect, useCallback } from "react";
import { Switch, Spin, Input, Button, message as antdMessage, Tag } from "antd";
import {
  CircleCheckBig,
  Plug,
  RotateCw,
  Save,
  Server,
} from "lucide-react";
import type { OctopusClient, SandboxSettings } from "@octopus/tentacle";

interface Props {
  sdk: OctopusClient;
}

/**
 * Sandbox configuration section — rendered inside the 常规设置 tab.
 *
 * Configures the deepagents sandbox backend (currently only LangSmith is
 * officially supported). The API key is write-only: the backend stores it but
 * never returns the literal — only a `hasCredentials` flag. When a sandbox
 * workspace is selected and this is enabled + has credentials, the agent runs
 * in a LangSmithSandbox; otherwise it falls back to the local backend.
 */
export function SandboxSettingsSection({ sdk }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<SandboxSettings | null>(null);
  // Local draft for the write-only key field.
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [snapshotId, setSnapshotId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await sdk.getSandboxSettings();
      setData(s);
      setApiKeyEnv(s.apiKeyEnv ?? "");
      setTemplateName(s.templateName ?? "");
      setSnapshotId(s.snapshotId ?? "");
      setApiKeyDraft("");
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sdk]);

  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (enabled: boolean) => {
    if (!data) return;
    try {
      const s = await sdk.updateSandboxSettings({ enabled });
      setData(s);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    }
  };

  const saveDetails = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        apiKeyEnv: apiKeyEnv.trim() || null,
        templateName: templateName.trim() || null,
        snapshotId: snapshotId.trim() || null,
      };
      // Only send apiKey when the user typed something (write-only field).
      if (apiKeyDraft.trim()) patch.apiKey = apiKeyDraft.trim();
      const s = await sdk.updateSandboxSettings(patch);
      setData(s);
      setApiKeyDraft("");
      antdMessage.success("已保存");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}><Spin /></div>
    );
  }

  return (
    <div style={{
      border: "1px solid var(--gray-150)", borderRadius: 10,
      padding: 16, marginBottom: 16, background: "var(--gray-0)",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Server style={{ fontSize: 18, color: "var(--main-color)" }} />
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>沙盒环境</span>
        {data?.hasCredentials ? (
          <Tag color="success" icon={<CircleCheckBig />}>已配置密钥</Tag>
        ) : (
          <Tag color="default">未配置密钥</Tag>
        )}
        <Switch checked={data?.enabled === true} onChange={toggleEnabled} />
      </div>

      <div style={{ fontSize: 12, color: "var(--gray-500)", marginBottom: 12 }}>
        启用后，选择「沙盒」环境的工作区会在 LangSmith 沙盒中运行（需配置 API Key）。未配置或未启用时，沙盒工作区会回退到本机目录。
      </div>

      {/* Provider (fixed to langsmith for now) */}
      <Field label="服务商">
        <Tag color="blue">LangSmith</Tag>
        <span style={{ fontSize: 12, color: "var(--gray-400)", marginLeft: 8 }}>
          目前仅支持 deepagents 内置的 LangSmith 沙盒
        </span>
      </Field>

      {/* API key (write-only) */}
      <Field label="API Key">
        <Input.Password
          value={apiKeyDraft}
          onChange={(e) => setApiKeyDraft(e.target.value)}
          placeholder={data?.hasCredentials ? "已配置（输入新值可覆盖）" : "例如 lsv2_..."}
          autoComplete="new-password"
        />
      </Field>

      {/* API key env (alternative) */}
      <Field label="API Key 环境变量（可选）">
        <Input
          value={apiKeyEnv}
          onChange={(e) => setApiKeyEnv(e.target.value)}
          placeholder="例如 LANGSMITH_API_KEY"
        />
      </Field>

      {/* Template name */}
      <Field label="模板名称（可选）">
        <Input
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          placeholder="LangSmith 沙盒模板名"
        />
      </Field>

      {/* Snapshot id */}
      <Field label="快照 ID（可选）">
        <Input
          value={snapshotId}
          onChange={(e) => setSnapshotId(e.target.value)}
          placeholder="从快照启动沙盒"
        />
      </Field>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button
          type="primary" icon={<Save />}
          loading={saving} onClick={saveDetails}
        >
          保存
        </Button>
        <Button icon={<RotateCw />} onClick={load}>刷新</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "var(--gray-600)", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
        <Plug style={{ fontSize: 12 }} />
        {label}
      </div>
      {children}
    </div>
  );
}
