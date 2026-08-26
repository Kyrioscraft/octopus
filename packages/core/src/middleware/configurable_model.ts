/**
 * Middleware for runtime model selection via LangGraph runtime context.
 * Equivalent to Python `cortex.configurable_model.ConfigurableModelMiddleware`.
 *
 * The runtime model spec is read from `runtime.context["model"]` (set by the
 * server via the top-level `context` field of the LangGraph config — NOT
 * `configurable`). When present and different from the current model, a new
 * chat model instance is built via `buildChatModel` (which reuses the same
 * provider config / base_url / api_key resolution as the main graph) and
 * swapped in for this model call.
 */

import { z } from "zod";
import { getLogger } from "../logging.js";
import { buildModelIdentitySection } from "../prompts.js";

const logger = getLogger("configurable.model");
const ANTHROPIC_ONLY_SETTINGS = new Set(["cache_control"]);
const MODEL_IDENTITY_RE = /### Model Identity\n\n.*?(?=\n### |\n---|\n$)/s;

function _isAnthropicModel(model: any): boolean {
  try {
    const lsParams = model._get_ls_params?.();
    return typeof lsParams === "object" && lsParams !== null && lsParams["ls_provider"] === "anthropic";
  } catch { return false; }
}

/**
 * Context schema — declares the runtime context fields this middleware reads.
 *
 * LangGraph only surfaces context keys that a middleware declares via its
 * `contextSchema` (it filters `config.context` through the schema before
 * handing it to the hook). Without this declaration, `runtime.context.model`
 * would always be `undefined` even if the server sets `config.context.model`.
 */
const _contextSchema = z.object({
  /** Runtime model override as a `provider:model` spec. */
  model: z.string().optional(),
  /** Runtime model params (temperature, max_tokens, ...) merged into model_settings. */
  model_params: z.record(z.string(), z.any()).optional(),
  /** Tracks the model spec currently in use, to avoid rebuilding on every call. */
  _current_model_spec: z.string().optional(),
});

class ConfigurableModelMiddleware {
  name = "ConfigurableModelMiddleware";
  contextSchema = _contextSchema;
  private _buildChatModel: (spec: string) => Promise<any>;
  constructor(buildChatModel: (spec: string) => Promise<any>) { this._buildChatModel = buildChatModel; }

  wrapModelCall = async (request: any, handler: (req: any) => any): Promise<any> => {
    const modifiedRequest = await _applyOverrides(request, this._buildChatModel);
    return handler(modifiedRequest || request);
  };
}


/**
 * Inspect runtime context for a model spec / model params override and, when
 * present, build a fresh model instance and return a patched request.
 *
 * Returns the original request unchanged when no override applies.
 */
async function _applyOverrides(request: any, buildChatModel: (spec: string) => Promise<any>): Promise<any> {
  const runtime = request.runtime;
  if (!runtime) return request;
  const ctx = runtime.context;
  if (!ctx || typeof ctx !== "object") return request;
  const overrides: Record<string, any> = {};
  let newModel: any = null;
  const modelSpec = ctx["model"];
  if (modelSpec && typeof modelSpec === "string") {
    // Rebuild only when the requested spec differs from the one already
    // materialized in this run, to avoid reconstructing the LLM every call.
    if (modelSpec !== ctx["_current_model_spec"]) {
      logger.debug(`Overriding model to ${modelSpec}`);
      try { newModel = await buildChatModel(modelSpec); overrides["model"] = newModel; }
      catch (err) { logger.exception(`Failed to resolve runtime model override '${modelSpec}'`, err); return request; }
    }
  }
  const modelParams = ctx["model_params"];
  if (modelParams && typeof modelParams === "object") {
    overrides["modelSettings"] = { ...(request.modelSettings || {}), ...modelParams };
  }
  if (Object.keys(overrides).length === 0) return request;
  if (newModel !== null && !_isAnthropicModel(newModel)) {
    const settings = overrides["modelSettings"] || request.modelSettings || {};
    const filtered = Object.fromEntries(Object.entries(settings).filter(([k]) => !ANTHROPIC_ONLY_SETTINGS.has(k)));
    overrides["modelSettings"] = filtered;
  }
  if (newModel !== null && request.systemPrompt) {
    const newIdentity = buildModelIdentitySection(newModel.model || newModel.name, _isAnthropicModel(newModel) ? "anthropic" : undefined);
    const patched = request.systemPrompt.replace(MODEL_IDENTITY_RE, newIdentity);
    if (patched !== request.systemPrompt) overrides["systemPrompt"] = patched;
  }
  // Override by spreading — `request.override()` does not exist on the
  // langchain `ModelRequest`; the handler accepts a (possibly modified)
  // request and reads camelCase fields (systemPrompt / modelSettings / model).
  return { ...request, ...overrides };
}

export { ConfigurableModelMiddleware };
