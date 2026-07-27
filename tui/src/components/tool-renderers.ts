// =============================================================================
// Tool renderer registry — strategy pattern mapping tool names to previews.
// Equivalent to Python tui.widgets.tool_renderers.
// =============================================================================

import type { RenderedToolPreview } from "./tool-widgets.js";
import {
  renderGenericPreview,
  renderWriteFilePreview,
  renderEditFilePreview,
  renderExecutePreview,
  renderWebRequestPreview,
  renderTaskPreview,
} from "./tool-widgets.js";

// =============================================================================
// ToolRenderer interface
// =============================================================================

export interface ToolRenderer {
  /** Human-readable name for this renderer. */
  name: string;
  /** Render the tool arguments into a preview. */
  render: (args: Record<string, unknown>) => RenderedToolPreview;
}

// =============================================================================
// Registry
// =============================================================================

const _RENDERER_REGISTRY: Map<string, ToolRenderer> = new Map();

function register(name: string, renderer: ToolRenderer): void {
  _RENDERER_REGISTRY.set(name, renderer);
}

// Register tool-specific renderers
register("write_file", { name: "WriteFile", render: renderWriteFilePreview });
register("write", { name: "WriteFile", render: renderWriteFilePreview });
register("edit_file", { name: "EditFile", render: renderEditFilePreview });
register("edit", { name: "EditFile", render: renderEditFilePreview });
register("execute", { name: "Execute", render: renderExecutePreview });
register("shell", { name: "Shell", render: renderExecutePreview });
register("bash", { name: "Shell", render: renderExecutePreview });
register("web_search", { name: "WebSearch", render: renderWebRequestPreview });
register("web_fetch", { name: "FetchURL", render: renderWebRequestPreview });
register("fetch_url", { name: "FetchURL", render: renderWebRequestPreview });
register("task", { name: "Task", render: renderTaskPreview });
register("start_async_task", { name: "Task", render: renderTaskPreview });

// Generic fallback renderer
const _genericRenderer: ToolRenderer = {
  name: "Generic",
  render: renderGenericPreview,
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the renderer for a given tool name.
 * Returns `null` if no renderer is registered (caller should use a fallback).
 */
export function getRenderer(toolName: string): ToolRenderer | null {
  // Normalize: strip prefixes and lowercase
  const normalized = toolName
    .replace(/^mcp__/, "")
    .replace(/__/g, "_")
    .toLowerCase();

  // Direct lookup
  const exact = _RENDERER_REGISTRY.get(toolName);
  if (exact) return exact;

  // Normalized lookup
  const normalizedRenderer = _RENDERER_REGISTRY.get(normalized);
  if (normalizedRenderer) return normalizedRenderer;

  // Fallback for known tool patterns
  if (normalized.includes("write") || normalized.includes("create")) {
    return _RENDERER_REGISTRY.get("write_file") ?? null;
  }
  if (normalized.includes("edit") || normalized.includes("patch") || normalized.includes("update")) {
    return _RENDERER_REGISTRY.get("edit_file") ?? null;
  }
  if (normalized.includes("exec") || normalized.includes("run") || normalized.includes("cmd")) {
    return _RENDERER_REGISTRY.get("execute") ?? null;
  }
  if (normalized.includes("search") || normalized.includes("fetch") || normalized.includes("url")) {
    return _RENDERER_REGISTRY.get("web_search") ?? null;
  }

  // Generic fallback
  return _genericRenderer;
}

/**
 * List all registered tool renderer names.
 */
export function listRenderers(): string[] {
  return Array.from(_RENDERER_REGISTRY.keys());
}
