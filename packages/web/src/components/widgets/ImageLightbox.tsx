import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Download } from "lucide-react";
import { useLightboxStore } from "../../stores/lightbox.js";

/**
 * Full-screen image viewer.
 *
 * Mounted once (see layouts/AppLayout) and driven by `stores/lightbox.ts`, so any
 * thumbnail can open it with `openImage(url)`. Closes on Escape, on backdrop
 * click, or via the close button; offers a download action when the caller knows
 * the file name.
 */
export function ImageLightbox() {
  const src = useLightboxStore((s) => s.src);
  const alt = useLightboxStore((s) => s.alt);
  const downloadName = useLightboxStore((s) => s.downloadName);
  const close = useLightboxStore((s) => s.close);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, close]);

  if (!src) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "图片预览"}
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        background: "color-mix(in srgb, var(--gray-1000) 72%, transparent)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        animation: "fadeIn var(--dur-2) var(--ease-out)",
        cursor: "zoom-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "relative", display: "flex", flexDirection: "column", gap: 10, cursor: "default" }}
      >
        <img
          src={src}
          alt={alt ?? ""}
          style={{
            maxWidth: "min(92vw, 1400px)",
            maxHeight: "84vh",
            objectFit: "contain",
            borderRadius: "var(--radius-lg)",
            boxShadow: "var(--shadow-lg)",
            background: "var(--bg-elevated)",
          }}
        />
        {alt && (
          <div style={{
            textAlign: "center", fontSize: "var(--text-xs)",
            color: "rgba(255,255,255,0.75)",
          }}>
            {alt}
          </div>
        )}
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "fixed", top: 16, right: 16, display: "flex", gap: 6, cursor: "default" }}
      >
        {downloadName && (
          <a
            href={src}
            download={downloadName}
            className="icon-btn focus-ring"
            aria-label="下载"
            title="下载"
            style={{
              color: "rgba(255,255,255,0.85)",
              background: "rgba(255,255,255,0.10)",
            }}
          >
            <span style={{ display: "flex", fontSize: 16 }}>
              <Download />
            </span>
          </a>
        )}
        <button
          type="button"
          className="icon-btn focus-ring"
          aria-label="关闭"
          title="关闭"
          onClick={close}
          style={{ color: "rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.10)" }}
        >
          <span style={{ display: "flex", fontSize: 16 }}>
            <X />
          </span>
        </button>
      </div>
    </div>,
    document.body,
  );
}