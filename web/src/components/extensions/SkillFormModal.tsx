import { useEffect, useState } from "react";
import { Modal, Input, message as antdMessage } from "antd";
import { OctopusClient, type SkillEntry } from "@octopus/tentacle";

const sdk = new OctopusClient();

interface SkillFormModalProps {
  open: boolean;
  /** When set, edit mode; otherwise create mode. */
  initial?: SkillEntry | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Create / edit a user-defined skill. In edit mode the name is read-only
 * (the backend keys skills by name); only description + content are editable.
 */
export function SkillFormModal({ open, initial, onClose, onSaved }: SkillFormModalProps) {
  const isEdit = !!initial;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  // Load full content when opening in edit mode.
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setContent("");
    if (initial) {
      sdk.getSkill(initial.name).then((d) => setContent(d.content ?? "")).catch(() => {});
    }
  }, [open, initial]);

  const submit = async () => {
    const n = name.trim();
    if (!n) { antdMessage.warning("名称不能为空"); return; }
    setLoading(true);
    try {
      if (isEdit && initial) {
        await sdk.updateSkill(initial.name, { description, content });
        antdMessage.success("已更新");
      } else {
        await sdk.createSkill({ name: n, description, content });
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
      title={isEdit ? "编辑 Skill" : "创建 Skill"}
      onCancel={onClose}
      onOk={submit}
      okText="保存"
      cancelText="取消"
      confirmLoading={loading}
      width={640}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        <div>
          <div style={labelStyle}>名称</div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：code-reviewer"
            disabled={isEdit}
            style={inputStyle}
          />
        </div>
        <div>
          <div style={labelStyle}>描述</div>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话描述这个 Skill 的用途"
            style={inputStyle}
          />
        </div>
        <div>
          <div style={labelStyle}>内容（SKILL.md 正文）</div>
          <Input.TextArea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            autoSize={{ minRows: 10, maxRows: 24 }}
            placeholder={"支持 Markdown。frontmatter（name/description）由系统自动生成。"}
            style={{ ...inputStyle, fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace", fontSize: 12.5 }}
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
