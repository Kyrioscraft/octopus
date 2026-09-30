import { Input, Tooltip, Select, Spin } from "antd";
import {
  ArrowUp, Square,
  FileWarning,
  Plus,
  X, FileText, Upload,
} from "lucide-react";
import { ACCESS_MODES, MODE_ORDER, type AccessMode } from "../constants.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import type { SlashCommandEntry } from "@octopus/tentacle";
import { useState, useCallback, useRef } from "react";
import { openImage } from "../../../stores/lightbox.js";

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

/** Mode glyph in a flex box of its own. The lucide svg is an inline element, so
 *  dropped straight into the chip it sits on the text baseline and reads a
 *  couple of pixels high; a flex box centres it on the text instead. */
function ModeIcon({ mode }: { mode: { icon: React.ReactNode; dangerous: boolean } }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        color: mode.dangerous ? "var(--accent)" : "var(--text-secondary)",
      }}
    >
      {mode.icon}
    </span>
  );
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
        borderRadius: "var(--radius-md)",
        border: att.status === "error"
          ? "1px solid var(--color-error-500)"
          : "1px solid var(--border-default)",
        background: "var(--bg-elevated)",
        overflow: "hidden",
      }}
    >
      {isImage && att.previewUrl ? (
        <img
          src={att.previewUrl}
          alt={att.name}
          className="attachment-thumb"
          style={{
            width: 58, height: 46, objectFit: "cover",
            borderRadius: "var(--radius-md)", display: "block", cursor: "zoom-in",
          }}
          onClick={() => openImage(att.previewUrl!, { alt: att.name, downloadName: att.name })}
        />
      ) : (
        <>
          {att.status === "error"
            ? <FileWarning size={18} style={{ color: "var(--color-error-500)", flexShrink: 0 }} />
            : <FileText size={18} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />}
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, maxWidth: 150 }}>
            <span style={{ fontSize: "var(--text-xs)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {att.name}
            </span>
            <span className="tnum" style={{ fontSize: "var(--text-2xs)", color: "var(--text-tertiary)" }}>
              {att.status === "error" ? "上传失败" : formatBytes(att.size)}
            </span>
          </div>
        </>
      )}
      {att.status === "uploading" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "color-mix(in srgb, var(--bg-elevated) 70%, transparent)",
          borderRadius: "var(--radius-md)",
        }}>
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
            position: "absolute", top: 3, right: 3,
            width: 17, height: 17, borderRadius: "50%",
            border: "none", padding: 0, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "color-mix(in srgb, var(--gray-1000) 62%, transparent)",
            color: "#fff",
            fontSize: 11, lineHeight: 1,
          }}
        >
          {att.status === "error" ? "↻" : <X size={10} />}
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The shared composer — an elevated card with a textarea on top and a bottom
 * toolbar row (attach, access-mode chip, model chip, send/stop button).
 *
 * This component is reused in two places: the start screen and the floating
 * bottom slot. It owns NO state — everything (text, busy, accessMode, model,
 * attachments, handlers) is passed in via props so the parent (Chat.tsx)
 * stays the single source of truth for input state.
 *
 * Attachments enter three ways (opencode parity): paste into the textarea,
 * drag & drop onto the card, and the + button's file picker. The hidden input
 * is rendered here and triggered programmatically; the actual upload state
 * machine lives in useChat.addFiles.
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
  const canSend = (!text.trim() && !hasReadyAttachment) || uploadingCount > 0;

  return (
    <div
      ref={containerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`composer${dragging ? " is-dragging" : ""}`}
      style={{
        position: "relative",
        display: "flex", flexDirection: "column",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        padding: "10px 10px 8px",
        boxShadow: "var(--shadow-md)",
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
        <div className="composer-drop">
          <Upload size={15} />
          释放以添加附件
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

      {/* Textarea */}
      <TextArea
        value={text} onChange={(e) => handleTextChange(e.target.value)}
        onKeyDown={onKey}
        onPaste={handlePaste}
        placeholder={ACCESS_MODES[accessMode].placeholder}
        autoSize={showStart ? { minRows: 3, maxRows: 8 } : { minRows: 2, maxRows: 8 }}
        disabled={busy}
        variant="borderless"
        style={{
          flex: 1, resize: "none", fontSize: "var(--text-md)", fontFamily: "inherit",
          lineHeight: 1.6, padding: "2px 4px", background: "transparent",
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
          <button
            type="button"
            className="icon-btn focus-ring"
            aria-label="添加附件"
            onClick={() => attachInputRef.current?.click()}
            style={{ width: 28, height: 28 }}
          >
            <span style={{ display: "flex", fontSize: 16 }}>
              <Plus />
            </span>
          </button>
        </Tooltip>

        {/* Access mode — icon in the trigger, two-line (name + hint) options,
            Shift+Tab hint in the tooltip. */}
        <Tooltip title="Shift+Tab 切换模式" mouseEnterDelay={0.8}>
          <Select<AccessMode>
            size="small" variant="borderless"
            className="chip-select"
            value={accessMode}
            onChange={(v) => setAccessMode(v)}
            style={{ minWidth: 104, fontSize: "var(--text-xs)" }}
            popupMatchSelectWidth={false}
            labelRender={(p) => {
              const m = ACCESS_MODES[p.value as AccessMode];
              return (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <ModeIcon mode={m} />
                  {m.label}
                </span>
              );
            }}
            optionRender={(opt) => {
              const m = ACCESS_MODES[opt.value as AccessMode];
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ModeIcon mode={m} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <span style={{ fontSize: "var(--text-sm)", lineHeight: 1.5 }}>{m.label}</span>
                    <span style={{ fontSize: "var(--text-2xs)", lineHeight: 1.45, color: "var(--text-tertiary)" }}>
                      {m.hint}
                    </span>
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
          className="chip-select"
          value={selectedModel ?? "__default__"}
          onChange={(v) => setSelectedModel(v === "__default__" ? null : v)}
          style={{ width: 148, fontSize: "var(--text-xs)" }}
          popupMatchSelectWidth={false}
          options={[
            { label: "默认模型", value: "__default__" },
            ...modelOptions,
          ]}
        />

        <Tooltip title={busy ? "停止回答" : canSend ? "" : "发送"}>
          <button
            type="button"
            className={`send-btn focus-ring${busy ? " is-stop" : ""}`}
            aria-label={busy ? "停止回答" : "发送"}
            onClick={busy ? onStop : onSend}
            disabled={!busy && canSend}
          >
            {busy ? <Square size={13} /> : <ArrowUp size={16} />}
          </button>
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