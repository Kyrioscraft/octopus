import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Tooltip, Switch, Spin, Modal, Tag, message as antdMessage } from "antd";
import {
  ArrowLeftOutlined,
  EditOutlined,
  DeleteOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { OctopusClient, type SubagentEntry } from "@octopus/tentacle";
import { SubagentFormModal } from "../components/extensions/SubagentFormModal.js";

const sdk = new OctopusClient();

/**
 * Subagent detail page. Top bar with back + enable/disable switch +
 * edit/delete (user-defined only). Body: system prompt (code panel),
 * description, model override, tools, meta.
 */
export function SubagentDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [subagent, setSubagent] = useState<SubagentEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    try {
      setSubagent(await sdk.getSubagent(name));
    } catch (err: any) {
      antdMessage.error(err?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => { load(); }, [load]);

  const editable = subagent?.editable ?? false;

  const toggle = async (enabled: boolean) => {
    if (!name) return;
    setToggling(true);
    try {
      await sdk.setSubagentEnabled(name, enabled);
      setSubagent((s) => (s ? { ...s, enabled } : s));
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
      title: "删除子智能体",
      content: `确定删除「${name}」吗？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await sdk.deleteSubagent(name);
          antdMessage.success("已删除");
          navigate("/extensions/subagents");
        } catch (err: any) {
          antdMessage.error(err?.message ?? "删除失败");
        }
      },
    });
  };

  const back = () => navigate("/extensions/subagents");

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
            <RobotOutlined />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={titleStyle}>{name}</div>
            <div style={subtitleStyle}>
              {subagent ? `来源：${subagent.origin}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--gray-700)" }}>
            启用
            <Switch
              checked={subagent?.enabled ?? false}
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
        ) : subagent ? (
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* System prompt */}
            <div style={panelStyle}>
              <div style={panelHeaderStyle}>系统提示词</div>
              <pre style={codeBlockStyle}>
                {subagent.systemPrompt || "（无）"}
              </pre>
            </div>

            {/* Description */}
            {subagent.description && (
              <div style={descStyle}>{subagent.description}</div>
            )}

            {/* Model override */}
            {subagent.model && (
              <DetailRow label="模型覆盖" value={subagent.model} mono />
            )}

            {/* Tools */}
            {subagent.tools.length > 0 && (
              <div style={panelStyle}>
                <div style={panelHeaderStyle}>工具 ({subagent.tools.length})</div>
                <div style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {subagent.tools.map((t) => (
                    <Tag key={t} style={{ margin: 0, borderRadius: 4, fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace" }}>
                      {t}
                    </Tag>
                  ))}
                </div>
              </div>
            )}

            {/* Meta */}
            <div style={panelStyle}>
              <div style={panelHeaderStyle}>元信息</div>
              <div style={{ padding: "4px 0" }}>
                <DetailRow label="类型" value={subagent.origin} />
                <DetailRow label="来源" value={subagent.source ?? "—"} />
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: 80, textAlign: "center", color: "var(--gray-500)" }}>
            子智能体不存在
          </div>
        )}
      </div>

      {subagent && (
        <SubagentFormModal
          open={editOpen}
          initial={subagent}
          onClose={() => setEditOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "10px 16px",
      }}
    >
      <div style={{ width: 100, flexShrink: 0, fontSize: 13, color: "var(--gray-500)" }}>
        {label}
      </div>
      <div
        style={{
          flex: 1,
          fontSize: 13,
          color: "var(--gray-900)",
          whiteSpace: mono ? "pre-wrap" : "normal",
          wordBreak: "break-all",
          fontFamily: mono ? "'SFMono-Regular', Consolas, Menlo, monospace" : "inherit",
        }}
      >
        {value}
      </div>
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
};

const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  color: "var(--gray-600)",
};

const descStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--gray-700)",
  lineHeight: 1.6,
  padding: "12px 16px",
  background: "var(--gray-0)",
  borderRadius: 10,
  border: "1px solid var(--gray-150)",
};

const panelStyle: React.CSSProperties = {
  background: "var(--gray-0)",
  borderRadius: 10,
  border: "1px solid var(--gray-150)",
  overflow: "hidden",
};

const panelHeaderStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  padding: "12px 16px",
  borderBottom: "1px solid var(--gray-100)",
  background: "var(--gray-25)",
};

const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  padding: 16,
  fontSize: 12.5,
  lineHeight: 1.6,
  color: "var(--gray-900)",
  fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
