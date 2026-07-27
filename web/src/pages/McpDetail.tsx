import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Tooltip, Switch, Spin, Modal, Tabs, message as antdMessage } from "antd";
import {
  ArrowLeftOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
} from "@ant-design/icons";
import { OctopusClient, type McpServerEntry } from "@octopus/tentacle";
import { McpFormModal } from "../components/extensions/McpFormModal.js";

const sdk = new OctopusClient();

/**
 * MCP server detail page. Top bar with back + enable/disable switch +
 * edit/delete (user-defined only). Body tabs: 信息 (config) + 工具
 * (config JSON, since the backend has no separate tool-list endpoint).
 */
export function McpDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [server, setServer] = useState<McpServerEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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
              icon={<ArrowLeftOutlined />}
              onClick={back}
              style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
            />
          </Tooltip>
          <div style={iconTileStyle}>
            <ApiOutlined />
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
                  icon={<EditOutlined />}
                  onClick={() => setEditOpen(true)}
                  style={iconBtnStyle}
                />
              </Tooltip>
              <Tooltip title="删除">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
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
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px" }}>
            <Tabs
              defaultActiveKey="info"
              items={[
                {
                  key: "info",
                  label: "信息",
                  children: <InfoTab server={server} />,
                },
                {
                  key: "tools",
                  label: "配置 (JSON)",
                  children: <JsonTab config={server.config} />,
                },
              ]}
            />
          </div>
        ) : (
          <div style={{ padding: 80, textAlign: "center", color: "var(--gray-500)" }}>
            MCP 不存在
          </div>
        )}
      </div>

      {server && (
        <McpFormModal
          open={editOpen}
          initial={server}
          onClose={() => setEditOpen(false)}
          onSaved={load}
        />
      )}
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
    <div style={panelStyle}>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 16,
            padding: "10px 16px",
            borderBottom: i < rows.length - 1 ? "1px solid var(--gray-100)" : "none",
          }}
        >
          <div style={{ width: 100, flexShrink: 0, fontSize: 13, color: "var(--gray-500)" }}>
            {r.label}
          </div>
          <div
            style={{
              flex: 1,
              fontSize: 13,
              color: "var(--gray-900)",
              whiteSpace: r.mono ? "pre-wrap" : "normal",
              wordBreak: "break-all",
              fontFamily: r.mono ? "'SFMono-Regular', Consolas, Menlo, monospace" : "inherit",
            }}
          >
            {r.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Raw JSON view of the config object. */
function JsonTab({ config }: { config: Record<string, unknown> }) {
  return (
    <div style={panelStyle}>
      <pre
        style={{
          margin: 0,
          padding: 16,
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
    </div>
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

const panelStyle: React.CSSProperties = {
  background: "var(--gray-0)",
  borderRadius: 10,
  border: "1px solid var(--gray-150)",
  overflow: "hidden",
};
