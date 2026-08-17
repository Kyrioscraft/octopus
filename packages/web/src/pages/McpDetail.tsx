import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Tooltip, Switch, Spin, Modal, message as antdMessage } from "antd";
import {
  ArrowLeft,
  Pencil,
  Plug,
  Trash2,
} from "lucide-react";
import { OctopusClient, type McpServerEntry } from "@octopus/tentacle";
import { SettingsCard, InfoRow } from "../components/shared/SettingsCard.js";

const sdk = new OctopusClient();

/**
 * MCP server detail page. Top bar with back + enable/disable switch +
 * edit/delete (user-defined only). Body: settings-style stacked cards —
 * 信息 + 配置 (JSON) (the backend has no separate tool-list endpoint).
 */
export function McpDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [server, setServer] = useState<McpServerEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    try {
      setServer(await sdk.getMcp(name));
    } catch (err: any) {
      antdMessage.error(err?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => { load(); }, [load]);

  const editable = server?.editable ?? false;

  const toggle = async (enabled: boolean) => {
    if (!name) return;
    setToggling(true);
    try {
      await sdk.setMcpEnabled(name, enabled);
      setServer((s) => (s ? { ...s, enabled } : s));
      antdMessage.success(enabled ? "已启用" : "已禁用");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    } finally {
      setToggling(false);
    }
  };

  const onDelete = () => {
    if (!name) return;
    Modal.confirm({
      title: "删除 MCP",
      content: `确定删除「${name}」吗？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await sdk.deleteMcp(name);
          antdMessage.success("已删除");
          navigate("/extensions/mcp");
        } catch (err: any) {
          antdMessage.error(err?.message ?? "删除失败");
        }
      },
    });
  };

  const back = () => navigate("/extensions/mcp");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Top bar */}
      <div style={topBarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <Tooltip title="返回">
            <Button
              type="text"
              size="small"
              icon={<ArrowLeft />}
              onClick={back}
              style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
            />
          </Tooltip>
          <div style={iconTileStyle}>
            <Plug />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={titleStyle}>{name}</div>
            <div style={subtitleStyle}>{server?.transport}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--gray-700)" }}>
            启用
            <Switch
              checked={server?.enabled ?? false}
              loading={toggling}
              onChange={toggle}
              size="small"
            />
          </div>
          {editable && (
            <>
              <Tooltip title="编辑">
                <Button
                  type="text"
                  size="small"
                  icon={<Pencil />}
                  onClick={() => navigate(`/extensions/mcp/${encodeURIComponent(name!)}/edit`)}
                  style={iconBtnStyle}
                />
              </Tooltip>
              <Tooltip title="删除">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<Trash2 />}
                  onClick={onDelete}
                  style={iconBtnStyle}
                />
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--gray-10)" }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
            <Spin />
          </div>
        ) : server ? (
          <div style={{ maxWidth: 900, margin: "0 auto", padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>
            <SettingsCard title="信息">
              <InfoTab server={server} />
            </SettingsCard>
            <SettingsCard title="配置 (JSON)">
              <JsonTab config={server.config} />
            </SettingsCard>
          </div>
        ) : (
          <div style={{ padding: 80, textAlign: "center", color: "var(--gray-500)" }}>
            MCP 不存在
          </div>
        )}
      </div>
    </div>
  );
}

/** Read-only structured view of the server config. */
function InfoTab({ server }: { server: McpServerEntry }) {
  const cfg = server.config ?? {};
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "名称", value: server.name },
    { label: "传输方式", value: server.transport },
    { label: "来源", value: server.origin },
    { label: "状态", value: server.status ? (server.status === "ok" ? "已连接" : server.status) : (server.enabled ? "已启用" : "已禁用") },
  ];
  if (server.error) rows.push({ label: "错误", value: server.error });

  if (server.transport === "stdio") {
    rows.push({ label: "command", value: (cfg.command as string) ?? "—", mono: true });
    const a = cfg.args;
    rows.push({ label: "args", value: Array.isArray(a) ? a.join(" ") : ((a as string) ?? "—"), mono: true });
    if (cfg.env && typeof cfg.env === "object") {
      rows.push({ label: "env", value: JSON.stringify(cfg.env, null, 2), mono: true });
    }
  } else {
    rows.push({ label: "url", value: (cfg.url as string) ?? "—", mono: true });
    if (cfg.headers && typeof cfg.headers === "object") {
      rows.push({ label: "headers", value: JSON.stringify(cfg.headers, null, 2), mono: true });
    }
    if (cfg.timeout != null) rows.push({ label: "timeout", value: `${cfg.timeout}s`, mono: true });
  }

  return (
    <div>
      {rows.map((r, i) => (
        <InfoRow key={i} label={r.label} value={r.value} mono={r.mono} />
      ))}
    </div>
  );
}

/** Raw JSON view of the config object. */
function JsonTab({ config }: { config: Record<string, unknown> }) {
  return (
    <pre
      style={{
        margin: 0,
        fontSize: 12.5,
        lineHeight: 1.6,
        color: "var(--gray-900)",
        fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {JSON.stringify(config, null, 2)}
    </pre>
  );
}

const topBarStyle: React.CSSProperties = {
  height: 45,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 16px",
  borderBottom: "1px solid var(--gray-150)",
  flexShrink: 0,
  background: "var(--gray-0)",
};

const iconTileStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: "var(--main-20)",
  color: "var(--main-color)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 17,
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--gray-1000)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--gray-500)",
  marginTop: 2,
  fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
};

const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  color: "var(--gray-600)",
};
