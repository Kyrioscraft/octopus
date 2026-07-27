/**
 * Middleware for runtime model selection via LangGraph runtime context.
 * Equivalent to Python `cortex.configurable_model.ConfigurableModelMiddleware`.
 */

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

async function _applyOverrides(request: any, buildChatModel: (spec: string) => Promise<any>): Promise<any> {
  const runtime = request.runtime;
  if (!runtime) return request;
  const ctx = runtime.context;
  if (!ctx || typeof ctx !== "object") return request;
  const overrides: Record<string, any> = {};
  let newModel: any = null;
  const modelSpec = ctx["model"];
  if (modelSpec && typeof modelSpec === "string") {
    if (modelSpec !== ctx["_current_model_spec"]) {
      logger.debug(`Overriding model to ${modelSpec}`);
      try { newModel = await buildChatModel(modelSpec); overrides["model"] = newModel; }
      catch (err) { logger.exception(`Failed to resolve runtime model override '${modelSpec}'`, err); return request; }
    }
  }
  const modelParams = ctx["model_params"];
  if (modelParams && typeof modelParams === "object") {
    overrides["model_settings"] = { ...(request.model_settings || {}), ...modelParams };
  }
  if (Object.keys(overrides).length === 0) return request;
  if (newModel !== null && !_isAnthropicModel(newModel)) {
    const settings = overrides["model_settings"] || request.model_settings || {};
    const filtered = Object.fromEntries(Object.entries(settings).filter(([k]) => !ANTHROPIC_ONLY_SETTINGS.has(k)));
    overrides["model_settings"] = filtered;
  }
  if (newModel !== null && request.system_prompt) {
    const newIdentity = buildModelIdentitySection(newModel.model || newModel.name, _isAnthropicModel(newModel) ? "anthropic" : undefined);
    const patched = request.system_prompt.replace(MODEL_IDENTITY_RE, newIdentity);
    if (patched !== request.system_prompt) overrides["system_prompt"] = patched;
  }
  if (typeof request.override === "function") return request.override(overrides);
  return { ...request, ...overrides };
}

class ConfigurableModelMiddleware {
  name = "ConfigurableModelMiddleware";
  private _buildChatModel: (spec: string) => Promise<any>;
  constructor(buildChatModel: (spec: string) => Promise<any>) { this._buildChatModel = buildChatModel; }

  wrapModelCall = (request: any, handler: (req: any) => any): any => handler(request);

  awrapModelCall = async (request: any, handler: (req: any) => Promise<any>): Promise<any> => {
    const modifiedRequest = await _applyOverrides(request, this._buildChatModel);
    return handler(modifiedRequest || request);
  };
}

export { ConfigurableModelMiddleware };
