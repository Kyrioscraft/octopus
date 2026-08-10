// =============================================================================
// Input parsing — @file mentions, paste path detection, media tracking.
// Equivalent to Python tui.input + Python tui.media_utils.
// =============================================================================

import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath, isAbsolute } from "node:path";

// =============================================================================
// Patterns
// =============================================================================

/** Matches @file mentions, excluding email addresses. */
export const FILE_MENTION_PATTERN = /(?:^|\s)@([^\s@]+(?:@[^\s@]+)*[^\s@]+)(?=\s|$)/g;

/** Matches pasted/dragged file paths from terminals. */
export const PASTED_PATH_PATTERN = /(?:(?:\/|[A-Za-z]:\\)[^\s,\]]+|file:\/\/\/[^\s,\]]+)/g;

/** Matches image placeholders like [image 1] */
export const IMAGE_PLACEHOLDER_PATTERN = /\[image\s+(\d+)\]/gi;

/** Matches video placeholders like [video 1] */
export const VIDEO_PLACEHOLDER_PATTERN = /\[video\s+(\d+)\]/gi;

// =============================================================================
// Media tracking
// =============================================================================

export interface ImageData {
  id: number;
  base64Data: string;
  format: string;
  placeholder: string;
}

export interface VideoData {
  id: number;
  base64Data: string;
  format: string;
  placeholder: string;
}

export class MediaTracker {
  #images: Map<number, ImageData> = new Map();
  #videos: Map<number, VideoData> = new Map();
  #nextId = 1;

  addImage(base64Data: string, format: string): ImageData {
    const id = this.#nextId++;
    const img: ImageData = {
      id,
      base64Data,
      format,
      placeholder: `[image ${id}]`,
    };
    this.#images.set(id, img);
    return img;
  }

  addVideo(base64Data: string, format: string): VideoData {
    const id = this.#nextId++;
    const vid: VideoData = {
      id,
      base64Data,
      format,
      placeholder: `[video ${id}]`,
    };
    this.#videos.set(id, vid);
    return vid;
  }

  getImage(id: number): ImageData | undefined {
    return this.#images.get(id);
  }

  getVideo(id: number): VideoData | undefined {
    return this.#videos.get(id);
  }

  getAllImages(): ImageData[] {
    return Array.from(this.#images.values());
  }

  getAllVideos(): VideoData[] {
    return Array.from(this.#videos.values());
  }

  clear(): void {
    this.#images.clear();
    this.#videos.clear();
    this.#nextId = 1;
  }
}

// =============================================================================
// File mention parsing
// =============================================================================

/**
 * Extract @file mentions from text.
 * Returns the cleaned text (with mentions replaced by filenames) and a list of
 * resolved file paths.
 *
 * Equivalent to Python `parse_file_mentions()`.
 */
export function parseFileMentions(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const cleaned = text.replace(FILE_MENTION_PATTERN, (match, filePath) => {
    // Skip email addresses
    if (filePath.includes("@") && filePath.includes(".") && !filePath.startsWith("/")) {
      return match;
    }
    try {
      const resolved = isAbsolute(filePath)
        ? filePath
        : resolvePath(process.cwd(), filePath);
      if (existsSync(resolved)) {
        paths.push(resolved);
        return ` ${resolved} `;
      }
    } catch {
      /* ignore resolution errors */
    }
    return match;
  });

  return { text: cleaned, paths };
}

// =============================================================================
// Paste path parsing
// =============================================================================

/**
 * Parse pasted file paths from terminal drag-and-drop text.
 * Supports shell-quoted paths, file:// URIs, and Windows paths.
 *
 * Equivalent to Python `parse_pasted_file_paths()`.
 */
export function parsePastedFilePaths(text: string): string[] {
  const paths: string[] = [];
  const matches = text.matchAll(PASTED_PATH_PATTERN);

  for (const match of matches) {
    const raw = match[0];
    try {
      const normalized = normalizePastedPath(raw);
      if (normalized && existsSync(normalized)) {
        paths.push(normalized);
      }
    } catch {
      /* ignore invalid paths */
    }
  }

  return paths;
}

/**
 * Normalize a single pasted path — handle quoting, file://, drive letters.
 *
 * Equivalent to Python `normalize_pasted_path()`.
 */
export function normalizePastedPath(raw: string): string | null {
  let path = raw.trim();

  // Strip surrounding quotes
  if ((path.startsWith("'") && path.endsWith("'")) ||
      (path.startsWith('"') && path.endsWith('"'))) {
    path = path.slice(1, -1);
  }

  // Handle file:// URIs
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
    if (path.startsWith("/") && !path.startsWith("//")) {
      // Single slash: Unix path
    } else if (path.startsWith("//")) {
      // Double slash: UNC or Windows
      path = path.slice(1);
    }
  }

  // Decode URL-encoded characters
  try {
    path = decodeURIComponent(path);
  } catch {
    /* not URI-encoded */
  }

  // Normalize separators on Windows
  if (process.platform === "win32") {
    path = path.replace(/\//g, "\\");
  }

  return path || null;
}

// =============================================================================
// Media file validation
// =============================================================================

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".webm", ".mkv", ".flv", ".wmv",
]);

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Check if a file path is a supported image.
 */
export function isImageFile(path: string): boolean {
  const ext = path.toLowerCase().split(".").pop();
  return ext ? IMAGE_EXTENSIONS.has(`.${ext}`) : false;
}

/**
 * Check if a file path is a supported video.
 */
export function isVideoFile(path: string): boolean {
  const ext = path.toLowerCase().split(".").pop();
  return ext ? VIDEO_EXTENSIONS.has(`.${ext}`) : false;
}

/**
 * Check if a file is within the size limit for media upload.
 */
export function isMediaWithinSizeLimit(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.size <= MAX_MEDIA_BYTES;
  } catch {
    return false;
  }
}
