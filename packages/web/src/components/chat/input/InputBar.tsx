import { Input, Button, Tooltip, Select, Spin } from "antd";
import {
  ArrowUp, Square,
  FileWarning,
  Plus,
  Zap, X, FileText,
} from "lucide-react";
import { ACCESS_MODES, MODE_ORDER, type AccessMode } from "../constants.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import type { SlashCommandEntry } from "@octopus/tentacle";
import { useState, useCallback, useRef, useEffect } from "react";

const { TextArea } = Input;

/** A draft attachment as owned by useChat's addFiles state machine. */
export interface DraftAttachmentView {
  id: string;
  name: string;
  mime?: string;
  size: number;
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  path?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

/** One attachment chip: image thumbnail (click to enlarge) or file card,
 *  hover-revealed remove, upload spinner / error retry states. */
function AttachmentChip({
  att, onRemove, onRetry,
}: {
  att: DraftAttachmentView;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const isImage = (att.mime ?? "").startsWith("image/");
  return (
    <div
      style={{
        position: "relative", flexShrink: 0,
        display: "flex", alignItems: "center", gap: 6,
        height: 46, padding: isImage ? 0 : "4px 8px 4px 6px",
        borderRadius: 8,
        border: att.status === "error" ? "1px solid var(--danger-color, #f5222d)" : "1px solid var(--gray-150)",
        background: "var(--gray-0)",
        overflow: "hidden",
      }}
      className="attachment-chip"
    >
      {isImage && att.previewUrl ? (
        <img
          src={att.previewUrl}
          alt={att.name}
          style={{ width: 58, height: 46, objectFit: "cover", borderRadius: 8, display: "block", cursor: "zoom-in" }}
          onClick={() => window.open(att.previewUrl, "_blank")}
        />
      ) : (
        <>
          {att.status === "error"
            ? <FileWarning size={18} style={{ color: "var(--danger-color, #f5222d)", flexShrink: 0 }} />
            : <FileText size={18} style={{ color: "var(--gray-600)", flexShrink: 0 }} />}
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, maxWidth: 150 }}>
            <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {att.name}
            </span>
            <span style={{ fontSize: 11, color: "var(--gray-500, #999)" }}>
              {att.status === "error" ? "上传失败" : formatBytes(att.size)}
            </span>
          </div>
        </>
      )}
      {att.status === "uploading" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.6)", borderRadius: 8 }}>
          <Spin size="small" />
        </div>
      )}
      <Tooltip title={att.status === "error" ? "重试上传" : att.name}>
        <button
          type="button"
          aria-label={att.status === "error" ? "重试上传" : "移除附件"}
          onClick={(e) => {
            e.stopPropagation();
            if (att.status === "error") onRetry(att.id);
            else onRemove(att.id);
          }}
          style={{
            position: "absolute", top: 2, right: 2,
            width: 16, height: 16, borderRadius: "50%",
            border: "none", padding: 0, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.55)", color: "#fff",
          }}
          className="attachment-chip-x"
        >
          {att.status === "error" ? "↻" : <X size={10} />}
        </button>
      </Tooltip>
    </div>
  );
}

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
 * Attachments enter three ways (opencode parity): paste into the textarea,
 * drag & drop onto the card, and the + popover's two pickers (image / any
 * file). The hidden inputs are rendered here and triggered programmatically;
 * the actual upload state machine lives in useChat.addFiles.
 */
export function InputBar({
  text,
  setText,
  busy,
  accessMode,
  setAccessMode,
  attachments,
  onRemoveAttachment,
  onRetryAttachment,
  attachInputRef,
  onAddFiles,
  onKey,
  selectedModel,
  setSelectedModel,
  modelOptions,
  onSend,
  onStop,
  showStart,
  commands,
  onSlashSelect,
  onSystemCommand,
}: {
  text: string;
  setText: (v: string) => void;
  busy: boolean;
  accessMode: AccessMode;
  setAccessMode: (v: AccessMode) => void;
  attachments: DraftAttachmentView[];
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  attachInputRef: React.RefObject<HTMLInputElement | null>;
  onAddFiles: (files: FileList | File[]) => void;
  onKey: (e: React.KeyboardEvent) => void;
  selectedModel: string | null;
  setSelectedModel: (v: string | null) => void;
  modelOptions: Array<{ label: string; options: Array<{ label: string; value: string }> }>;
  onSend: () => void;
  onStop: () => void;
  showStart: boolean;
  commands: SlashCommandEntry[];
  onSlashSelect: (cmd: SlashCommandEntry) => void;
  onSystemCommand: (cmd: SlashCommandEntry) => void;
}) {
  const iconBtnStyle: React.CSSProperties = {
    height: 28, borderRadius: 8, flexShrink: 0,
    color: "var(--gray-600)", transition: "color 0.2s ease",
    display: "flex", alignItems: "center",
  };

  // ---- Slash-command state ----
  const [slashMenuVisible, setSlashMenuVisible] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  // ---- Drag & drop state ----
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);

  // Detect `/` at the start of input — show/hide the command menu.
  const handleTextChange = useCallback(
    (v: string) => {
      setText(v);
      // Show menu when input starts with `/` and hasn't hit a space yet.
      if (v.startsWith("/") && !v.includes(" ")) {
        setSlashQuery(v.slice(1));
        setSlashMenuVisible(true);
      } else {
        setSlashMenuVisible(false);
        setSlashQuery("");
      }
    },
    [setText],
  );

  // Paste with files (screenshots) → attachments instead of text.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        onAddFiles(files);
      }
    },
    [onAddFiles],
  );

  // Drag & drop — depth-counted so nested enter/leave pairs don't flicker.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault(); // required to allow the drop
  }, []);
  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onAddFiles(files);
    },
    [onAddFiles],
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommandEntry) => {
      setSlashMenuVisible(false);
      setSlashQuery("");
      if (cmd.kind === "system") {
        // System command: execute directly, no text insertion.
        onSystemCommand(cmd);
        // Clear the `/command` prefix from the input.
        setText("");
        return;
      }
      // Prompt command: replace `/command` with the template.
      const afterSlash = text.slice(1);
      const spaceIdx = afterSlash.indexOf(" ");
      const userInput = spaceIdx > 0 ? afterSlash.slice(spaceIdx + 1) : "";
      const template = (cmd.promptTemplate ?? "").replace("{input}", userInput);
      setText(template);
      onSlashSelect(cmd);
    },
    [text, setText, onSlashSelect, onSystemCommand],
  );

  const hasReadyAttachment = attachments.some((a) => a.status === "ready");
  const uploadingCount = attachments.filter((a) => a.status === "uploading").length;

  return (
    <div
      ref={containerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: "relative",
        display: "flex", flexDirection: "column",
        background: "var(--gray-25)",
        border: dragging ? "2px dashed var(--main-500)" : "1px solid var(--gray-150)",
        borderRadius: 13, padding: dragging ? "9px 9px 7px" : "10px 10px 8px",
        boxShadow: "0 2px 8px var(--shadow-1)",
        transition: "box-shadow 0.3s ease, border-color 0.15s ease",
      }}
    >
      {/* Slash-command autocomplete menu (above the textarea) */}
      <SlashCommandMenu
        commands={commands}
        query={slashQuery}
        visible={slashMenuVisible}
        onSelect={handleSlashSelect}
      />

      {/* Drop overlay */}
      {dragging && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 5, borderRadius: 13,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(255,255,255,0.85)", pointerEvents: "none",
          fontSize: 14, color: "var(--main-600, #16a34a)", fontWeight: 500,
        }}>
          释放以添加附件
        </div>
      )}

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

      {/* Attachment chips — horizontal scroll (opencode-style strip) */}
      {attachments.length > 0 && (
        <div style={{
          display: "flex", gap: 6, marginBottom: 8,
          overflowX: "auto", paddingBottom: 2,
          scrollbarWidth: "thin",
        }}>
          {attachments.map((att) => (
            <AttachmentChip key={att.id} att={att} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} />
          ))}
        </div>
      )}

      {/* Textarea (taller) */}
      <TextArea
        value={text} onChange={(e) => handleTextChange(e.target.value)}
        onKeyDown={onKey}
        onPaste={handlePaste}
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
        {/* Left group: + attachments (unified picker — images, docs, anything),
            access mode */}
        <Tooltip title="添加附件（图片 / 文件）" mouseEnterDelay={0.8}>
          <Button type="text" size="small"
            icon={<Plus />}
            onClick={() => attachInputRef.current?.click()}
            style={{ ...iconBtnStyle }}
            className="hover-green"
          />
        </Tooltip>

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

        <Tooltip title={busy ? "停止回答" : uploadingCount > 0 ? "附件上传中…" : ""}>
          <Button
            type="text" shape="circle"
            icon={busy ? <Square size={14} /> : <ArrowUp />}
            onClick={busy ? onStop : onSend}
            disabled={(!text.trim() && !hasReadyAttachment && !busy) || uploadingCount > 0}
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

      {/* Hidden file input for attachments — the unified picker (no accept
          filter: images, documents, anything). Value resets after each pick
          so picking the same file twice in a row still fires onChange. */}
      <input
        ref={attachInputRef} type="file" multiple style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) onAddFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
