import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Tooltip, Spin, Empty, message as antdMessage } from "antd";
import { ApiOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { OctopusClient, type McpServerEntry } from "@octopus/tentacle";
import { ExtensionCard } from "./ExtensionCard.js";
import { McpFormModal } from "./McpFormModal.js";

const sdk = new OctopusClient();

const TRANSPORT_COLORS: Record<string, string> = {
  stdio: "#52c41a",
  sse: "#fa8c16",
  http: "#1677ff",
  "streamable-http": "#1677ff",
};

const ORIGIN_LABEL: Record<McpServerEntry["origin"], string> = {
  file: "文件",
  "user-defined": "自定义",
};

interface McpCardListProps {
  servers: McpServerEntry[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * MCP tab: a card grid split into "已启用" and "已禁用". Disabled cards show
 * an inline "启用" action; enabled cards navigate to detail on click.
 */
export function McpCardList({ servers, loading, search, onReload }: McpCardListProps) {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const q = search.trim().toLowerCase();
  const filtered = servers.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.transport.toLowerCase().includes(q),
  );

  const enabled = filtered.filter((s) => s.enabled);
  const disabled = filtered.filter((s) => !s.enabled);

  const toggle = async (s: McpServerEntry, value: boolean) => {
    try {
      await sdk.setMcpEnabled(s.name, value);
      antdMessage.success(value ? "已启用" : "已禁用");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        <Tooltip title="刷新">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined spin={loading} />}
            onClick={onReload}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
          style={{ borderRadius: 6 }}
        >
          添加 MCP
        </Button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配 MCP" : "暂无 MCP"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {enabled.length > 0 && (
            <Section title={`已启用 (${enabled.length})`}>
              <Grid>
                {enabled.map((s) => (
                  <ExtensionCard
                    key={s.name}
                    icon={<ApiOutlined />}
                    title={s.name}
                    subtitle={s.transport}
                    description={describe(s)}
                    tags={[
                      { label: s.transport, color: TRANSPORT_COLORS[s.transport] },
                      ...(s.origin === "file" ? [{ label: ORIGIN_LABEL[s.origin] }] : []),
                    ]}
                    statusLabel={statusLabel(s)}
                    statusLevel={statusLevel(s)}
                    onClick={() => navigate(`/extensions/mcp/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </Grid>
            </Section>
          )}
          {disabled.length > 0 && (
            <Section title={`已禁用 (${disabled.length})`}>
              <Grid>
                {disabled.map((s) => (
                  <ExtensionCard
                    key={s.name}
                    icon={<ApiOutlined />}
                    title={s.name}
                    subtitle={s.transport}
                    description={describe(s)}
                    tags={[{ label: s.transport, color: TRANSPORT_COLORS[s.transport] }]}
                    disabled
                    actionLabel="启用"
                    onAction={() => toggle(s, true)}
                    onClick={() => navigate(`/extensions/mcp/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}

      <McpFormModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={onReload} />
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

function statusLabel(s: McpServerEntry): string {
  if (s.status === "ok") return "已连接";
  if (s.status && s.status !== "ok") return "连接异常";
  return "已启用";
}

function statusLevel(s: McpServerEntry): "success" | "warning" | "error" | "info" {
  if (s.status === "ok") return "success";
  if (s.status && s.status !== "ok") return "error";
  return "success";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={sectionHeaderStyle}>{title}</div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  marginBottom: 10,
  letterSpacing: "0.02em",
};
