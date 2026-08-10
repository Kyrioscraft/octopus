import { useEffect, useState } from "react";
import { Modal, Input, Select, message as antdMessage } from "antd";
import { OctopusClient, type SubagentEntry } from "@octopus/tentacle";

const sdk = new OctopusClient();

interface SubagentFormModalProps {
  open: boolean;
  /** When set, edit mode; otherwise create mode. */
  initial?: SubagentEntry | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Create / edit a user-defined subagent. Five fields: name (read-only in
 * edit), description, systemPrompt, tools (free-tag multi-select), model.
 */
export function SubagentFormModal({ open, initial, onClose, onSaved }: SubagentFormModalProps) {
  const isEdit = !!initial;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setSystemPrompt(initial?.systemPrompt ?? "");
    setTools(initial?.tools ?? []);
    setModel(initial?.model ?? "");
  }, [open, initial]);

  const submit = async () => {
    const n = name.trim();
    if (!n) { antdMessage.warning("名称不能为空"); return; }
    if (!systemPrompt.trim()) { antdMessage.warning("系统提示词不能为空"); return; }
    setLoading(true);
    try {
      // model: empty string → null (clears override); undefined when not provided.
      const modelValue = model.trim() === "" ? null : model.trim();
      if (isEdit && initial) {
        await sdk.updateSubagent(initial.name, {
          description,
          systemPrompt,
          tools,
          model: modelValue,
        });
        antdMessage.success("已更新");
      } else {
        await sdk.createSubagent({
          name: n,
          description,
          systemPrompt,
          tools,
          model: modelValue,
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
      title={isEdit ? "编辑子智能体" : "创建子智能体"}
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
            placeholder="例如：research-agent（唯一标识）"
            disabled={isEdit}
            style={inputStyle}
          />
        </div>
        <div>
          <div style={labelStyle}>描述</div>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="主智能体据此决定何时委派任务给此子智能体"
            style={inputStyle}
          />
        </div>
        <div>
          <div style={labelStyle}>系统提示词</div>
          <Input.TextArea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 20 }}
            placeholder="子智能体的行为指令..."
            style={{ ...inputStyle, fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace", fontSize: 12.5 }}
          />
        </div>
        <div>
          <div style={labelStyle}>工具（可选）</div>
          <Select
            mode="tags"
            value={tools}
            onChange={setTools}
            placeholder="输入工具名称后回车（白名单，留空则继承全部）"
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <div style={labelStyle}>模型覆盖（可选）</div>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="例如：anthropic:claude-sonnet-4-6（留空继承默认）"
            style={inputStyle}
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
