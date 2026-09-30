import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Tooltip, Switch, Spin, Modal, Tag, Select, message as antdMessage } from "antd";
import {
  ArrowLeft,
  Bot,
  Pencil,
  Trash2,
  Cpu,
} from "lucide-react";
import { OctopusClient, type SubagentEntry } from "@octopus/tentacle";
import { SettingsCard, InfoRow } from "../components/shared/SettingsCard.js";
import {
  topBarStyle,
  iconTileStyle,
  titleStyle,
  subtitleStyle,
  iconBtnStyle,
} from "../components/shared/PageHeader.js";

const sdk = new OctopusClient();

/** Friendly Chinese label for a subagent's origin. */
const ORIGIN_LABEL: Record<SubagentEntry["origin"], string> = {
  builtin: "内置",
  file: "文件",
  "user-defined": "自定义",
};

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
  const isBuiltin = subagent?.origin === "builtin";

  // Built-in model override modal state.
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [modelInput, setModelInput] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  // Grouped model options (same shape/format as the chat input's model Select).
  const [modelOptions, setModelOptions] = useState<
    Array<{ label: string; options: Array<{ label: string; value: string }> }>
  >([]);

  useEffect(() => {
    // Lazy-load once, when the page mounts (same source as the chat input).
    sdk
      .listModelSettings()
      .then((res) => {
        setModelOptions(
          res.providers
            .filter((p) => p.enabled && p.models.length > 0)
            .map((p) => ({
              label: p.displayName || p.name,
              options: p.models.map((m: string) => ({
                label: `${p.name}:${m}`,
                value: `${p.name}:${m}`,
              })),
            })),
        );
      })
      .catch(() => {
        // Non-fatal — the modal falls back to "默认模型" only.
      });
  }, []);

  const openModelModal = () => {
    setModelInput(subagent?.model ?? null);
    setModelModalOpen(true);
  };

  const saveModel = async () => {
    if (!name) return;
    setSavingModel(true);
    try {
      // null clears the override → back to the default model.
      const model = modelInput?.trim() ? modelInput.trim() : null;
      const updated = await sdk.updateSubagent(name, { model });
      setSubagent(updated);
      antdMessage.success(model ? "模型已更新" : "已恢复默认模型");
      setModelModalOpen(false);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    } finally {
      setSavingModel(false);
    }
  };

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
              icon={<ArrowLeft />}
              onClick={back}
              style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
            />
          </Tooltip>
          <div style={iconTileStyle}>
            <Bot />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={titleStyle}>{name}</div>
            <div style={subtitleStyle}>
              {subagent ? `来源：${ORIGIN_LABEL[subagent.origin]}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Only user-defined subagents can be toggled; builtin are always
              enabled (no switch), file sources are read-only. */}
          {editable && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--gray-700)" }}>
              启用
              <Switch
                checked={subagent?.enabled ?? false}
                loading={toggling}
                onChange={toggle}
                size="small"
              />
            </div>
          )}
          {isBuiltin && (
            <Tooltip title="修改模型">
              <Button
                type="text"
                size="small"
                icon={<Cpu />}
                onClick={openModelModal}
                style={iconBtnStyle}
              />
            </Tooltip>
          )}
          {editable && (
            <>
              <Tooltip title="编辑">
                <Button
                  type="text"
                  size="small"
                  icon={<Pencil />}
                  onClick={() => navigate(`/extensions/subagent/${encodeURIComponent(name!)}/edit`)}
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
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg-canvas)" }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
            <Spin />
          </div>
        ) : subagent ? (
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
            {/* System prompt */}
            <SettingsCard title="系统提示词">
              <pre style={codeBlockStyle}>
                {subagent.systemPrompt || "（无）"}
              </pre>
            </SettingsCard>

            {/* Description */}
            {subagent.description && (
              <SettingsCard title="描述">
                <div style={{ fontSize: 14, color: "var(--gray-700)", lineHeight: 1.6 }}>
                  {subagent.description}
                </div>
              </SettingsCard>
            )}

            {/* Model override + tools */}
            <SettingsCard title="模型">
              <InfoRow
                label="model"
                value={subagent.model ?? "默认模型"}
                mono
                action={
                  isBuiltin ? (
                    <Button type="link" size="small" onClick={openModelModal}>
                      修改
                    </Button>
                  ) : undefined
                }
              />
            </SettingsCard>

            {subagent.tools.length > 0 && (
              <SettingsCard title={`工具 (${subagent.tools.length})`}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {subagent.tools.map((t) => (
                    <Tag key={t} style={{ margin: 0, borderRadius: 4, fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace" }}>
                      {t}
                    </Tag>
                  ))}
                </div>
              </SettingsCard>
            )}

            {/* Meta */}
            <SettingsCard title="元信息">
              <InfoRow label="类型" value={ORIGIN_LABEL[subagent.origin]} />
              <InfoRow label="来源" value={subagent.source ?? "—"} />
            </SettingsCard>
          </div>
        ) : (
          <div style={{ padding: 80, textAlign: "center", color: "var(--gray-500)" }}>
            子智能体不存在
          </div>
        )}
      </div>

      {/* Built-in model override modal */}
      <Modal
        title="修改模型"
        open={modelModalOpen}
        onOk={saveModel}
        onCancel={() => setModelModalOpen(false)}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingModel}
        destroyOnClose
      >
        <Select
          style={{ width: "100%" }}
          placeholder="选择模型"
          value={modelInput ?? "__default__"}
          onChange={(v) => setModelInput(v === "__default__" ? null : v)}
          popupMatchSelectWidth={false}
          options={[
            { label: "默认模型", value: "__default__" },
            ...modelOptions,
          ]}
        />
      </Modal>
    </div>
  );
}

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
