import { useState } from "react";
import { Segmented, Button, Switch, Input, Select, Slider, Tag, Tooltip } from "antd";
import { CloseOutlined, StarOutlined } from "@ant-design/icons";

interface Props { open: boolean; onClose: () => void; }

const TABS = [
  { label: "模型", value: "model" },
  { label: "工具", value: "tools" },
  { label: "其他", value: "other" },
];

export function AgentConfigSidebar({ open, onClose }: Props) {
  const [tab, setTab] = useState("model");

  if (!open) return null;

  return (
    <div style={{
      position: "absolute", top: 0, right: 0, bottom: 0,
      width: 360, background: "var(--gray-0)",
      borderLeft: "1px solid var(--gray-150)",
      borderTopLeftRadius: 16, borderBottomLeftRadius: 16,
      boxShadow: "-4px 0 12px rgba(0,0,0,0.06)",
      zIndex: 50, display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 16px", borderBottom: "1px solid var(--gray-100)",
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--gray-1000)" }}>
          配置
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          <Tooltip title="设为默认">
            <Button type="text" size="small"
              icon={<StarOutlined style={{ fontSize: 16 }} />}
              style={{ width: 28, height: 28, borderRadius: 6 }} />
          </Tooltip>
          <Button type="text" size="small"
            icon={<CloseOutlined style={{ fontSize: 16 }} />}
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 6 }} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: "12px 16px 0", flexShrink: 0 }}>
        <Segmented block value={tab} onChange={(v) => setTab(v as string)} options={TABS}
          style={{ borderRadius: 10 }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {tab === "model" && <>
            <Section label="模型">
              <Select style={{ width: "100%" }}
                defaultValue="anthropic:claude-sonnet-4-6"
                options={[
                  { value: "anthropic:claude-sonnet-4-6", label: "Claude Sonnet 4" },
                  { value: "openai:gpt-4o", label: "GPT-4o" },
                ]} />
            </Section>
            <Section label="System Prompt">
              <Input.TextArea rows={4} placeholder="自定义系统提示词..."
                style={{ fontSize: 13, borderRadius: 8 }} />
            </Section>
          </>}

          {tab === "tools" && <>
            <Section label="Shell 执行">
              <Switch defaultChecked size="small" />
            </Section>
            <Section label="网页搜索">
              <Switch defaultChecked size="small" />
            </Section>
            <Section label="MCP 服务器" extra={<Button type="link" size="small" style={{ fontSize: 12, padding: 0 }}>配置</Button>}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Tag closable style={{ borderRadius: 4 }}>未选择任何 MCP</Tag>
              </div>
            </Section>
          </>}

          {tab === "other" && <>
            <Section label="温度">
              <Slider defaultValue={0.7} min={0} max={2} step={0.1}
                tooltip={{ formatter: (v) => v }} />
            </Section>
            <Section label="最大 Token">
              <Input type="number" defaultValue={4096}
                style={{ width: "100%", borderRadius: 8 }} />
            </Section>
          </>}

        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: "12px 16px", borderTop: "1px solid var(--gray-100)",
        flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8,
      }}>
        <Button onClick={onClose} style={{ borderRadius: 8 }}>取消</Button>
        <Button type="primary" onClick={onClose} style={{ borderRadius: 8 }}>保存</Button>
      </div>
    </div>
  );
}

function Section({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 6,
      }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gray-700)" }}>
          {label}
        </span>
        {extra}
      </div>
      {children}
    </div>
  );
}
