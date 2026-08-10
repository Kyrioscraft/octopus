import { useEffect, useState } from "react";
import { Modal, Input, Select, message as antdMessage } from "antd";
import { OctopusClient, type SlashCommandEntry } from "@octopus/tentacle";

const sdk = new OctopusClient();

interface SlashCommandFormModalProps {
  open: boolean;
  /** When set, edit mode; otherwise create mode. */
  initial?: SlashCommandEntry | null;
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORY_OPTIONS = [
  { label: "写作", value: "writing" },
  { label: "编程", value: "coding" },
  { label: "工具", value: "utility" },
];

const ACTION_OPTIONS = [
  { label: "插入模板", value: "insert" },
  { label: "插入并发送", value: "send" },
];

/**
 * Create / edit a user-defined slash command (prompt-template type only).
 */
export function SlashCommandFormModal({
  open,
  initial,
  onClose,
  onSaved,
}: SlashCommandFormModalProps) {
  const isEdit = !!initial;
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [action, setAction] = useState<"insert" | "send">("insert");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name ?? "");
      setDisplayName(initial.displayName ?? "");
      setDescription(initial.description ?? "");
      setPromptTemplate(initial.promptTemplate ?? "");
      setAction((initial.action as "insert" | "send") ?? "insert");
      setCategory(initial.category ?? undefined);
    } else {
      setName("");
      setDisplayName("");
      setDescription("");
      setPromptTemplate("");
      setAction("insert");
      setCategory(undefined);
    }
  }, [open, initial]);

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      antdMessage.warning("命令名不能为空");
      return;
    }
    if (!displayName.trim()) {
      antdMessage.warning("显示名不能为空");
      return;
    }
    if (!promptTemplate.trim()) {
      antdMessage.warning("提示模板不能为空");
      return;
    }
    setLoading(true);
    try {
      if (isEdit && initial) {
        await sdk.updateSlashCommand(initial.id, {
          name: n,
          displayName: displayName.trim(),
          description: description.trim(),
          promptTemplate: promptTemplate.trim(),
          action,
          category: category || null,
        });
        antdMessage.success("已更新");
      } else {
        await sdk.createSlashCommand({
          name: n,
          displayName: displayName.trim(),
          description: description.trim(),
          promptTemplate: promptTemplate.trim(),
          action,
          category: category || null,
        });
        antdMessage.success("已创建");
      }
      onSaved();
      onClose();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? "编辑斜杠命令" : "创建斜杠命令"}
      onCancel={onClose}
      onOk={submit}
      okText="保存"
      cancelText="取消"
      confirmLoading={loading}
      width={560}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>命令名（英文）</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：translate"
              disabled={isEdit}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>显示名</div>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如：翻译"
              style={inputStyle}
            />
          </div>
        </div>
        <div>
          <div style={labelStyle}>描述</div>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="在命令菜单中显示的简短描述"
            style={inputStyle}
          />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>行为</div>
            <Select
              value={action}
              onChange={(v) => setAction(v)}
              options={ACTION_OPTIONS}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>分类</div>
            <Select
              value={category}
              onChange={(v) => setCategory(v)}
              placeholder="选择分类"
              allowClear
              options={CATEGORY_OPTIONS}
              style={{ width: "100%" }}
            />
          </div>
        </div>
        <div>
          <div style={labelStyle}>
            提示模板{" "}
            <span style={{ fontWeight: 400, color: "var(--gray-400)", fontSize: 11 }}>
              （使用 {"{input}"} 作为用户输入的占位符）
            </span>
          </div>
          <Input.TextArea
            value={promptTemplate}
            onChange={(e) => setPromptTemplate(e.target.value)}
            autoSize={{ minRows: 4, maxRows: 12 }}
            placeholder={"请将以下文本翻译成中文：\n{input}"}
            style={{
              ...inputStyle,
              fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
              fontSize: 12.5,
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  borderRadius: 8,
};
