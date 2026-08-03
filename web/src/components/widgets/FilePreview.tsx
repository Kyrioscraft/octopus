import { useEffect, useMemo, useState } from "react";
import { Button, Tooltip, message as antdMessage, Spin } from "antd";
import {
  Check,
  CodeXml,
  Download,
  Eye,
  Maximize,
  Minimize,
  Pencil,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { Markdown } from "./Markdown.js";
import type { PreviewType, WorkspaceFileContent } from "@octopus/tentacle";

// =============================================================================
// FilePreview — shared file viewer for workspace files.
//
// Mirrors yuxi's AgentFilePreview.vue. Consumed by the workspace file tree
// (WorkspaceFileTree) and the standalone Workspace page. Renders by `previewType`:
// image / pdf / html (sandboxed iframe) / markdown / code (highlighted) / text
// / unsupported. Supports inline edit for .md/.txt with dirty tracking + save.
// =============================================================================

export interface FilePreviewProps {
  /** Resolved file content (from getWorkspaceFile). Null while loading. */
  file: WorkspaceFileContent | null;
  /** Optional blob URL for binary previews (image/pdf). */
  blobUrl?: string | null;
  loading?: boolean;
  /** Whether the edit affordance is shown (default true). */
  editable?: boolean;
  /** Whether download button is shown (default true). */
  showDownload?: boolean;
  /** Whether fullscreen affordance is shown (default true). */
  showFullscreen?: boolean;
  /** Whether the header (filename + actions) is shown. */
  showHeader?: boolean;
  /** Called when the user saves an edit. Returns a promise. */
  onSave?: (content: string) => Promise<void>;
  /** Called when the user clicks download. */
  onDownload?: () => void;
  /** Container height mode. */
  fullHeight?: boolean;
}

const EDITABLE_TYPES: PreviewType[] = ["markdown", "text"];

export function FilePreview({
  file,
  blobUrl,
  loading,
  editable = true,
  showDownload = true,
  showFullscreen = true,
  showHeader = true,
  onSave,
  onDownload,
  fullHeight = false,
}: FilePreviewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // HTML preview: toggle between rendered and source.
  const [showHtmlSource, setShowHtmlSource] = useState(false);

  // Reset draft when the file changes or editing toggles off.
  useEffect(() => {
    if (editing && file?.content) setDraft(file.content);
  }, [editing, file?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEditableType = file ? EDITABLE_TYPES.includes(file.previewType) : false;
  const canEdit = editable && isEditableType && !!onSave;

  const startEdit = () => {
    if (file?.content != null) {
      setDraft(file.content);
      setEditing(true);
    }
  };
  const cancelEdit = () => setEditing(false);
  const dirty = editing && file?.content != null && draft !== file.content;

  const submitSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
      antdMessage.success("已保存");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const body = useMemo(() => {
    if (loading) {
      return (
        <div style={{ padding: 24, textAlign: "center" }}>
          <Spin />
        </div>
      );
    }
    if (!file) {
      return (
        <div style={{ padding: 24, textAlign: "center", color: "var(--gray-400)" }}>
          选择左侧文件以预览
        </div>
      );
    }
    if (!file.supported) {
      return (
        <div style={{ padding: 24, textAlign: "center", color: "var(--gray-500)" }}>
          {file.message ?? "该文件不支持在线预览"}
        </div>
      );
    }

    // Edit mode (textarea) for editable types.
    if (editing) {
      return (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            width: "100%",
            minHeight: 360,
            border: "1px solid var(--gray-150)",
            borderRadius: 8,
            padding: 12,
            fontFamily: "'JetBrains Mono', Consolas, monospace",
            fontSize: 13,
            lineHeight: 1.6,
            resize: "vertical",
            outline: "none",
          }}
          autoFocus
        />
      );
    }

    switch (file.previewType) {
      case "image":
        return blobUrl ? (
          <div style={{ textAlign: "center", padding: 12 }}>
            <img
              src={blobUrl}
              alt={file.name}
              style={{ maxWidth: "100%", borderRadius: 6 }}
            />
          </div>
        ) : (
          <Empty text="图片加载中…" />
        );
      case "pdf":
        return blobUrl ? (
          <iframe
            src={blobUrl}
            title={file.name}
            style={{ width: "100%", height: "70vh", border: "none", borderRadius: 6 }}
          />
        ) : (
          <Empty text="PDF 加载中…" />
        );
      case "html":
        return (
          <div>
            {showHtmlSource ? (
              <pre style={codeStyle}>{file.content ?? ""}</pre>
            ) : (
              <iframe
                srcDoc={file.content ?? ""}
                title={file.name}
                sandbox="allow-scripts"
                style={{ width: "100%", height: "70vh", border: "1px solid var(--gray-150)", borderRadius: 6 }}
              />
            )}
          </div>
        );
      case "markdown":
        return (
          <div style={{ padding: "4px 4px" }}>
            <Markdown content={file.content ?? ""} />
          </div>
        );
      case "code":
        return (
          <pre style={codeStyle}>
            <code>{file.content ?? ""}</code>
          </pre>
        );
      case "text":
        return <pre style={textStyle}>{file.content ?? ""}</pre>;
      default:
        return (
          <Empty text={file.message ?? "该文件不支持在线预览"} />
        );
    }
  }, [loading, file, blobUrl, editing, draft, showHtmlSource]);

  const header = showHeader && file && (
    <div style={headerStyle}>
      <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {file.name}
      </span>
      <div style={{ display: "flex", gap: 2 }}>
        {file.previewType === "html" && (
          <Tooltip title={showHtmlSource ? "查看渲染" : "查看源码"}>
            <Button size="small" type="text" icon={showHtmlSource ? <Eye /> : <CodeXml />}
              onClick={() => setShowHtmlSource((v) => !v)} />
          </Tooltip>
        )}
        {canEdit && !editing && (
          <Tooltip title="编辑">
            <Button size="small" type="text" icon={<Pencil />} onClick={startEdit} />
          </Tooltip>
        )}
        {editing && (
          <>
            <Tooltip title="保存">
              <Button size="small" type="text" icon={<Check />} loading={saving}
                onClick={submitSave} disabled={!dirty} />
            </Tooltip>
            <Tooltip title="取消">
              <Button size="small" type="text" icon={<X />} onClick={cancelEdit} disabled={saving} />
            </Tooltip>
          </>
        )}
        {showDownload && onDownload && (
          <Tooltip title="下载">
            <Button size="small" type="text" icon={<Download />} onClick={onDownload} />
          </Tooltip>
        )}
        {showFullscreen && (
          <Tooltip title={fullscreen ? "退出全屏" : "全屏"}>
            <Button size="small" type="text"
              icon={fullscreen ? <Minimize /> : <Maximize />}
              onClick={() => setFullscreen((v) => !v)} />
          </Tooltip>
        )}
      </div>
    </div>
  );

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: fullHeight ? "100%" : "auto",
    minWidth: 0,
  };

  if (fullscreen) {
    return createPortal(
      <div style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "var(--gray-0)", display: "flex", flexDirection: "column",
      }}>
        {header}
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>{body}</div>
      </div>,
      document.body,
    );
  }

  return (
    <div style={containerStyle}>
      {header}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>{body}</div>
    </div>
  );
}

// --- small helpers ---------------------------------------------------------

const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4,
  padding: "8px 12px", borderBottom: "1px solid var(--gray-150)",
  flexShrink: 0,
};

const codeStyle: React.CSSProperties = {
  margin: 0, padding: 12,
  background: "var(--gray-50)", borderRadius: 6,
  fontFamily: "'JetBrains Mono', Consolas, monospace",
  fontSize: 12.5, lineHeight: 1.6,
  overflow: "auto", whiteSpace: "pre",
};

const textStyle: React.CSSProperties = {
  ...codeStyle,
  whiteSpace: "pre-wrap", wordBreak: "break-word",
};

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: 32, textAlign: "center", color: "var(--gray-400)", fontSize: 13 }}>
      {text}
    </div>
  );
}
