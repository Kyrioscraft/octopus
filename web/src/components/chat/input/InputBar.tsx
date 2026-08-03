import { Input, Button, Tooltip, Popover, Select, Tag } from "antd";
import {
  ArrowUp, Pause,
  Paperclip,
  Plus,
  FilePlus, Image,
  Zap,
} from "lucide-react";
import { ACCESS_MODES, MODE_ORDER, type AccessMode } from "../constants.js";

const { TextArea } = Input;

/**
 * The shared input bar — a bordered card with a textarea on top and a bottom
 * toolbar row (attachments popover, access-mode select, model select, send/stop
 * button).
 *
 * This component is reused in two places: the start screen and the bottom
 * input slot. It owns NO state — everything (text, busy, accessMode, model,
 * attachments, handlers) is passed in via props so the parent (Chat.tsx)
 * stays the single source of truth for input state.
 *
 * The hidden file input for attachments is rendered here (triggered
 * programmatically by the + popover) and refs itself via `attachInputRef`
 * passed from the parent so the ref lifetime matches the component's.
 */
export function InputBar({
  text,
  setText,
  busy,
  accessMode,
  setAccessMode,
  attachments,
  onRemoveAttachment,
  attachInputRef,
  onPickAttachments,
  onKey,
  selectedModel,
  setSelectedModel,
  modelOptions,
  onSend,
  onStop,
  showStart,
}: {
  text: string;
  setText: (v: string) => void;
  busy: boolean;
  accessMode: AccessMode;
  setAccessMode: (v: AccessMode) => void;
  attachments: string[];
  onRemoveAttachment: (index: number) => void;
  attachInputRef: React.RefObject<HTMLInputElement | null>;
  onPickAttachments: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKey: (e: React.KeyboardEvent) => void;
  selectedModel: string | null;
  setSelectedModel: (v: string | null) => void;
  modelOptions: Array<{ label: string; options: Array<{ label: string; value: string }> }>;
  onSend: () => void;
  onStop: () => void;
  showStart: boolean;
}) {
  const ppStyle: React.CSSProperties = {
    padding: "4px 8px", cursor: "pointer", fontSize: 13, borderRadius: 4,
    transition: "background-color 0.15s ease",
  };
  const iconBtnStyle: React.CSSProperties = {
    height: 28, borderRadius: 8, flexShrink: 0,
    color: "var(--gray-600)", transition: "color 0.2s ease",
    display: "flex", alignItems: "center",
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--gray-0)",
      border: `1px solid ${ACCESS_MODES[accessMode].borderColor}`,
      borderRadius: 13, padding: "10px 10px 8px",
      boxShadow: "0 2px 8px var(--shadow-1)",
      transition: "box-shadow 0.3s ease, border-color 0.3s ease",
    }}>
      {/* High-privilege banner: surfaces the risk whenever an autonomous mode
          is armed so the user knows changes will apply without per-step
          approval. `auto` still redirects shell file-writes to edit/write_file;
          `full` runs everything unchecked, including those. */}
      {accessMode === "auto" && !busy && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 12, color: "var(--main-color)",
          padding: "2px 6px", marginBottom: 6,
          background: "var(--main-50)", borderRadius: 6,
        }}>
          <Zap /> 自动模式：将直接执行文件变更，不再逐步确认
        </div>
      )}
      {accessMode === "full" && !busy && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 12, color: "var(--danger-color, #f5222d)",
          padding: "2px 6px", marginBottom: 6,
          background: "rgba(245, 34, 45, 0.08)", borderRadius: 6,
        }}>
          <Zap /> 完全控制：连安全命令也将自动执行，不再审核，请谨慎
        </div>
      )}

      {/* Attachment chips (if any) */}
      {attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {attachments.map((name, i) => (
            <Tag
              key={i} closable onClose={() => onRemoveAttachment(i)}
              style={{ marginInlineEnd: 0 }}
            >
              <Paperclip style={{ marginRight: 4 }} />
              {name}
            </Tag>
          ))}
        </div>
      )}

      {/* Textarea (taller) */}
      <TextArea
        value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={ACCESS_MODES[accessMode].placeholder}
        autoSize={showStart ? { minRows: 3, maxRows: 8 } : { minRows: 2, maxRows: 8 }}
        disabled={busy}
        variant="borderless"
        style={{
          flex: 1, resize: "none", fontSize: 15, fontFamily: "inherit",
          lineHeight: 1.5, padding: "2px 4px", background: "transparent",
        }}
        autoFocus
      />

      {/* Bottom toolbar row — all controls live here, send button rightmost */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        marginTop: 8, flexShrink: 0,
      }}>
        {/* Left group: + attachments, access mode */}
        <Popover
          placement="topLeft"
          trigger="click"
          overlayStyle={{ padding: 4 }}
          content={
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div
                style={{ ...ppStyle, display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => attachInputRef.current?.click()}
              >
                <FilePlus /> 添加文件
              </div>
              <div
                style={{ ...ppStyle, display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => attachInputRef.current?.click()}
              >
                <Image /> 上传图片
              </div>
            </div>
          }
        >
          <Button type="text" size="small"
            icon={<Plus />}
            style={{ ...iconBtnStyle }}
            className="hover-green"
          />
        </Popover>

        {/* Access mode — icon in the trigger, two-line (name + hint) options,
            Shift+Tab hint in the tooltip. */}
        <Tooltip title="Shift+Tab 切换模式" mouseEnterDelay={0.8}>
          <Select<AccessMode>
            size="small" variant="borderless"
            value={accessMode}
            onChange={(v) => setAccessMode(v)}
            style={{ minWidth: 110, fontSize: 12 }}
            popupMatchSelectWidth={false}
            labelRender={(p) => {
              const m = ACCESS_MODES[p.value as AccessMode];
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: m.dangerous ? "var(--main-color)" : "var(--gray-600)" }}>
                    {m.icon}
                  </span>
                  {m.label}
                </span>
              );
            }}
            optionRender={(opt) => {
              const m = ACCESS_MODES[opt.value as AccessMode];
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                  <span style={{ color: m.dangerous ? "var(--main-color)" : "var(--gray-600)" }}>
                    {m.icon}
                  </span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: 13 }}>{m.label}</span>
                    <span style={{ fontSize: 11, color: "var(--gray-600)" }}>{m.hint}</span>
                  </div>
                </div>
              );
            }}
            options={MODE_ORDER.map((m) => ({ value: m, label: ACCESS_MODES[m].label }))}
          />
        </Tooltip>

        {/* Spacer pushes the right group to the end */}
        <div style={{ flex: 1 }} />

        {/* Right group: model + send */}
        <Select
          size="small" variant="borderless"
          value={selectedModel ?? "__default__"}
          onChange={(v) => setSelectedModel(v === "__default__" ? null : v)}
          style={{ width: 150, fontSize: 12 }}
          popupMatchSelectWidth={false}
          options={[
            { label: "默认模型", value: "__default__" },
            ...modelOptions,
          ]}
        />

        <Tooltip title={busy ? "停止回答" : ""}>
          <Button
            type="text" shape="circle"
            icon={busy ? <Pause /> : <ArrowUp />}
            onClick={busy ? onStop : onSend}
            disabled={!text.trim() && !busy}
            style={{
              width: 32, height: 32, flexShrink: 0, border: "none",
              background: "var(--main-500)", color: "var(--gray-0)",
              boxShadow: "0 2px 6px var(--shadow-2)",
              transition: "all 0.2s ease",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--main-color)";
              e.currentTarget.style.color = "var(--gray-0)";
              e.currentTarget.style.boxShadow = "0 4px 8px var(--shadow-3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--main-500)";
              e.currentTarget.style.color = "var(--gray-0)";
              e.currentTarget.style.boxShadow = "0 2px 6px var(--shadow-2)";
            }}
          />
        </Tooltip>
      </div>

      {/* Hidden file input for attachments. */}
      <input
        ref={attachInputRef} type="file" multiple style={{ display: "none" }}
        onChange={onPickAttachments}
      />
    </div>
  );
}
