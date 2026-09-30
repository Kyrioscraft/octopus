import { useState, useEffect } from "react";
import { FileText } from "lucide-react";
import { OctopusClient } from "@octopus/tentacle";
import type { MsgAttachment } from "../types.js";
import { openImage } from "../../../stores/lightbox.js";

const sdk = new OctopusClient();

/**
 * Module-level blob-URL cache for history-loaded attachment previews
 * (workspaceId is implied by the thread's binding — we keep the LAST resolved
 * default workspace id from an upload/download response; refs uploaded by
 * this client always carry the right one via the snapshot's thread row).
 *
 * Keyed by attachment path; object URLs are never revoked (bounded by the
 * number of distinct attachments viewed per session).
 */
const previewCache = new Map<string, string>();
/** Last-known workspace id — set on first successful preview fetch. */
let lastWorkspaceId: string | undefined;

function fetchPreviewUrl(att: MsgAttachment, workspaceId: string | undefined): Promise<string | undefined> {
  const cached = previewCache.get(att.path);
  if (cached) return Promise.resolve(cached);
  return (async () => {
    try {
      const ws = workspaceId ?? lastWorkspaceId;
      if (!ws) return undefined;
      const blob = await sdk.downloadWorkspaceFile(ws, att.path);
      const url = URL.createObjectURL(blob);
      previewCache.set(att.path, url);
      return url;
    } catch {
      return undefined;
    }
  })();
}

/**
 * Render a user message's attachments: image thumbnails (click opens the
 * in-app lightbox) and file cards. Previews prefer the locally-carried object
 * URL (optimistic / live turns); history messages lazily fetch bytes via the
 * workspace download API.
 */
export function MessageAttachments({
  attachments,
  workspaceId,
}: {
  attachments: MsgAttachment[];
  workspaceId?: string;
}) {
  if (!attachments?.length) return null;
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 6,
      marginTop: 6, justifyContent: "flex-end", maxWidth: "100%",
    }}>
      {attachments.map((att, i) => (
        <AttachmentThumb key={`${att.path}_${i}`} att={att} workspaceId={workspaceId} />
      ))}
    </div>
  );
}

function AttachmentThumb({ att, workspaceId }: { att: MsgAttachment; workspaceId?: string }) {
  const isImage = (att.mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.name);
  const [url, setUrl] = useState<string | undefined>(
    att.previewUrl ?? previewCache.get(att.path),
  );

  useEffect(() => {
    if (!isImage || url) return;
    let cancelled = false;
    void fetchPreviewUrl(att, workspaceId).then((fetched) => {
      if (!cancelled && fetched) setUrl(fetched);
    });
    return () => { cancelled = true; };
  }, [att.path, isImage, url, workspaceId, att]);

  if (isImage) {
    return url ? (
      <img
        src={url}
        alt={att.name}
        title={att.name}
        className="attachment-thumb"
        onClick={() => openImage(url, { alt: att.name, downloadName: att.name })}
        style={{
          width: 140, maxHeight: 140, objectFit: "cover",
          borderRadius: "var(--radius-md)", border: "1px solid var(--border-default)",
          cursor: "zoom-in", display: "block",
        }}
      />
    ) : (
      <div style={{
        width: 140, height: 90, borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-default)", background: "var(--bg-muted)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "var(--text-xs)", color: "var(--text-tertiary)",
      }}>
        {att.name}
      </div>
    );
  }
  return (
    <div
      title={att.name}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 10px", borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-default)", background: "var(--bg-elevated)",
        maxWidth: 220,
      }}
    >
      <FileText size={18} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: "var(--text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {att.name}
        </span>
        <span className="tnum" style={{ fontSize: "var(--text-2xs)", color: "var(--text-tertiary)" }}>
          {att.size !== undefined
            ? att.size < 1024 * 1024 ? `${Math.ceil(att.size / 1024)}KB` : `${(att.size / 1048576).toFixed(1)}MB`
            : ""}
        </span>
      </div>
    </div>
  );
}
