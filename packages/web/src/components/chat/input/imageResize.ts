/**
 * Client-side image downscaling before upload (opencode's Image.normalize
 * equivalent, browser edition). Screenshots pasted from the clipboard are
 * often 2-4x display size in device pixels; inline base64 images ride along
 * EVERY turn's checkpoint history, so keeping them small is what keeps the
 * conversation affordable.
 *
 * Policy: keep PNG for images with transparency, re-encode everything else
 * to JPEG; only touch images over the dimension/byte thresholds — smaller
 * ones pass through untouched.
 */

const MAX_EDGE = 2048;
/** Re-encode to JPEG beyond this original size. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export interface ResizedImage {
  file: File;
  /** True when the image was re-encoded/resized (preview URL changed). */
  changed: boolean;
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    img.src = url;
  });
}

/** Does the PNG appear to use transparency? Sampling: scan a downscaled
 * copy's alpha channel — full scan is overkill for a heuristic. */
async function pngHasAlpha(file: File): Promise<boolean> {
  try {
    const img = await loadImage(file);
    const w = Math.min(img.naturalWidth, 64);
    const h = Math.min(img.naturalHeight, 64);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return true; // assume the worst — keep PNG
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Downscale/re-encode an image file when it exceeds the thresholds.
 * Non-images or already-small images return unchanged.
 */
export async function resizeImageIfNeeded(file: File): Promise<ResizedImage> {
  const isPng = file.type === "image/png";
  const isBitmap = file.type.startsWith("image/");
  if (!isBitmap || file.type === "image/gif") {
    // GIFs: canvas re-encode would kill animation — pass through.
    return { file, changed: false };
  }
  const needsWork =
    file.size > MAX_SOURCE_BYTES ||
    (await hasLargeEdge(file));
  if (!needsWork) return { file, changed: false };

  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { file, changed: false };
  if (!isPng) {
    // Flatten onto white so transparent JPEGs don't turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);

  const keepPng = isPng && (await pngHasAlpha(file));
  const type = keepPng ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, keepPng ? undefined : 0.85),
  );
  if (!blob || blob.size >= file.size) return { file, changed: false };
  const base = file.name.replace(/\.[^.]+$/, "");
  const name = keepPng ? `${base}.png` : `${base}.jpg`;
  return { file: new File([blob], name, { type }), changed: true };
}

async function hasLargeEdge(file: File): Promise<boolean> {
  try {
    const img = await loadImage(file);
    return Math.max(img.naturalWidth, img.naturalHeight) > MAX_EDGE;
  } catch {
    return false;
  }
}

/** Best-effort MIME resolution mirroring the server's expansion rules:
 * File.type first, then an extension map, else undefined (server sniffs). */
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown", txt: "text/plain", csv: "text/csv",
  json: "application/json", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function sniffMime(file: File): string | undefined {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return EXT_MIME[ext];
}
