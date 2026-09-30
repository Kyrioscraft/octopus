import { useNavigate } from "react-router-dom";
import { Button, Spin, Empty, Switch, Tag, Tooltip, message as antdMessage } from "antd";
import { Plug, Plus } from "lucide-react";
import { OctopusClient, type McpServerEntry } from "@octopus/tentacle";
import { SettingsCard, SettingsRow, SettingsRows, ListToolbar } from "../shared/SettingsCard.js";

const sdk = new OctopusClient();

const TRANSPORT_COLORS: Record<string, string> = {
  stdio: "var(--color-success-700)",
  sse: "var(--color-warning-700)",
  http: "var(--color-info-700)",
  "streamable-http": "var(--color-info-700)",
};

interface McpCardListProps {
  servers: McpServerEntry[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * MCP tab: settings-style grouped row lists split into "内置 / 文件"
 * (read-only) and "自定义" (user-defined). Each row has an inline enable
 * Switch and navigates to detail on click.
 */
export function McpCardList({ servers, loading, search, onReload }: McpCardListProps) {
  const navigate = useNavigate();

  const q = search.trim().toLowerCase();
  const filtered = servers.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.transport.toLowerCase().includes(q),
  );

  const builtin = filtered.filter((s) => s.origin !== "user-defined");
  const custom = filtered.filter((s) => s.origin === "user-defined");

  const toggle = async (s: McpServerEntry, value: boolean) => {
    try {
      await sdk.setMcpEnabled(s.name, value);
      antdMessage.success(value ? "已启用" : "已禁用");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    }
  };

  const row = (s: McpServerEntry) => (
    <SettingsRow
      key={s.name}
      icon={<Plug />}
      title={s.name}
      description={describe(s)}
      meta={
        <>
          <Tag
            style={{
              margin: 0,
              borderRadius: 999,
              fontSize: 11,
              padding: "0 8px",
              lineHeight: "20px",
              ...(TRANSPORT_COLORS[s.transport]
                ? { color: TRANSPORT_COLORS[s.transport], borderColor: TRANSPORT_COLORS[s.transport], background: "transparent" }
                : {}),
            }}
          >
            {s.transport}
          </Tag>
          {s.status && s.status !== "ok" && (
            <Tag color="error" style={{ margin: 0, borderRadius: 999, fontSize: 11, padding: "0 8px", lineHeight: "20px" }}>
              连接异常
            </Tag>
          )}
        </>
      }
      onClick={() => navigate(`/extensions/mcp/${encodeURIComponent(s.name)}`)}
    >
      <Switch
        size="small"
        checked={s.enabled}
        onClick={(_, e) => e.stopPropagation()}
        onChange={(v) => toggle(s, v)}
      />
    </SettingsRow>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Toolbar */}
      <ListToolbar loading={loading} onReload={onReload}>
        <Tooltip title="添加 MCP">
          <Button
            type="text"
            size="small"
            icon={<Plus />}
            onClick={() => navigate("/extensions/mcp/new")}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
      </ListToolbar>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配 MCP" : "暂无 MCP"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {builtin.length > 0 && (
            <SettingsCard title="内置 / 文件">
              <SettingsRows>{builtin.map(row)}</SettingsRows>
            </SettingsCard>
          )}
          {custom.length > 0 && (
            <SettingsCard title="自定义">
              <SettingsRows>{custom.map(row)}</SettingsRows>
            </SettingsCard>
          )}
        </>
      )}
    </div>
  );
}

function describe(s: McpServerEntry): string {
  const cfg = s.config ?? {};
  if (s.transport === "stdio") {
    const c = (cfg.command as string) ?? "";
    const a = cfg.args;
    return [c, Array.isArray(a) ? a.join(" ") : (a as string) ?? ""].filter(Boolean).join(" ");
  }
  return (cfg.url as string) ?? "";
}
