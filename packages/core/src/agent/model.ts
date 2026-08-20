/**
 * Model construction — extracted from agent/graph.ts.
 *
 * Equivalent to Python `cortex.server_graph._build_chat_model()` plus the
 * title-generation helper. Kept separate from graph compilation so
 * non-graph callers (title generation, ConfigurableModelMiddleware) reuse the
 * same provider resolution without pulling in the graph module.
 */

import {
  ModelConfig,
  getSandboxConfig,
  resolveSandboxApiKey,
  sandboxHasCredentials,
} from "../providers/index.js";
import type { ProviderConfig } from "../providers/index.js";
import { getLogger } from "../logging.js";

const logger = getLogger("agent.model");

// =============================================================================
// Model construction — equivalent to Python `_build_chat_model()`.
// =============================================================================

interface BuildModelResult {
  model: any; // BaseChatModel
  provider: string;
  modelName: string;
}

/**
 * Build a LangChain chat model instance from a model spec and provider config.
 *
 * Reads `~/.deepagents/config.toml` for per-provider params / base_url /
 * api_key_env. Provider overrides (from web DB) take precedence over
 * config.toml values. API keys are resolved via `resolveEnvVar` for
 * `DEEPAGENTS_CODE_` prefix support.
 *
 * Merges modelParams from ServerConfig on top of config.toml params.
 *
 * Equivalent to Python `cortex.server_graph._build_chat_model()`.
 */
export async function _buildChatModel(
  modelSpec: string,
  providerOverrides?: Record<string, { baseUrl?: string; apiKeyEnv?: string; apiKey?: string }>,
  modelParams?: Record<string, unknown>,
): Promise<BuildModelResult> {
  // Parse "provider:model"
  const colonIdx = modelSpec.indexOf(":");
  if (colonIdx <= 0) {
    throw new Error(
      `Invalid model spec "${modelSpec}" — must be in provider:model format`,
    );
  }
  const provider = modelSpec.slice(0, colonIdx);
  const modelName = modelSpec.slice(colonIdx + 1);

  // Read provider config from config.toml
  const config = ModelConfig.load();
  const providerConfig: ProviderConfig = config.providers[provider] ?? {};

  // Resolve params: config.toml base → modelParams override (modelParams wins)
  // → inference defaults fill any remaining gaps (thinking / max_tokens)
  const params: Record<string, unknown> = {
    ..._resolveInferenceDefaults(modelName, modelParams ?? {}),
    ...ModelConfig.getKwargs(provider, modelName),
    ...(modelParams ?? {}),
  };

  // Resolve base_url: providerOverride > config.toml > env var
  let baseUrl: string | undefined;
  const override = providerOverrides?.[provider];
  if (override?.baseUrl) {
    baseUrl = override.baseUrl;
  }
  if (!baseUrl) {
    baseUrl = ModelConfig.getBaseUrl(provider);
  }

  // Resolve API key: providerOverride (web DB) > config.json api_key > config.json api_key_env > env var
  let apiKey: string | undefined;
  if (override?.apiKey) {
    apiKey = override.apiKey;
  }
  if (!apiKey) {
    apiKey = ModelConfig.getApiKey(provider);
  }
  if (!apiKey) {
    logger.debug(
      `No API key configured for provider "${provider}". ` +
      "The model will fail at runtime if no key is available.",
    );
  }

  // Build the model instance
  let model: any;

  // Map provider to the appropriate LangChain chat model class.
  // Primary support: OpenAI + Anthropic. All other providers fall back to
  // ChatOpenAI with custom baseURL (OpenAI-compatible API pattern).
  switch (provider) {
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      model = new ChatAnthropic({
        model: modelName,
        streaming: true,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { clientOptions: { baseURL: baseUrl } } : {}),
      });
      // Apply known params individually (ChatAnthropic doesn't spread arbitrary params)
      if (params["temperature"] !== undefined) {
        (model as any).temperature = params["temperature"];
      }
      if (params["max_tokens"] !== undefined) {
        (model as any).maxTokens = params["max_tokens"];
      }
      break;
    }
    case "google_genai":
    case "google_vertexai": {
      // Google — use ChatOpenAI-compatible mode (Gemini API supports OpenAI spec via baseUrl)
      // For native Gemini SDK, install @langchain/google-genai separately.
      logger.debug(
        `Provider "${provider}" — using OpenAI-compatible mode. ` +
        "Install @langchain/google-genai for native Gemini SDK support.",
      );
      const { ChatOpenAI } = await import("@langchain/openai");
      model = new ChatOpenAI({
        model: modelName,
        streaming: true,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
        ...params,
      });
      break;
    }
    default: {
      // OpenAI + all OpenAI-compatible providers (deepseek, openrouter, together, xai,
      // groq, fireworks, perplexity, baseten, mistralai, nvidia, cohere, huggingface, etc.)
      const { ChatOpenAI } = await import("@langchain/openai");
      model = new ChatOpenAI({
        model: modelName,
        streaming: true,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
        ...params,
      });
    }
  }

  return { model, provider, modelName };
}

// =============================================================================
// Inference defaults — thinking / reasoning_effort / max_tokens.
//
// ZCode sends `thinking: {type:"enabled"}` + `reasoning_effort` + a large
// `max_tokens` for reasoning models. Without these, reasoning-capable models
// (deepseek-v4 etc.) skip their thinking phase entirely — noticeably worse at
// planning/delegation decisions. Octopus only passes through explicit config
// params, so reasoning is silently off by default.
// =============================================================================

/**
 * Model-name patterns for models that support the OpenAI-style `thinking`
 * param. Kept deliberately conservative — sending `thinking` to a model that
 * doesn't support it can 400. Extend as support is confirmed.
 */
const REASONING_MODEL_PATTERNS: RegExp[] = [
  /deepseek-v\d+-/i, // deepseek-v4-flash etc. (v4+ hybrid reasoning)
  /-o[134]($|[-.])/i, // OpenAI o1/o3/o4 series
  /-r1($|[-.])/i, // deepseek-r1 style
  /glm-4\.\d+[+-]/i, // GLM 4.5+ hybrid reasoning
  /qwen3.*-thinking/i,
  /qwen3-\w+-/i, // qwen3 hybrid models
];

function _isReasoningModel(modelName: string): boolean {
  return REASONING_MODEL_PATTERNS.some((re) => re.test(modelName));
}

/**
 * Compute default inference params for a model. User-explicit params (from
 * config.json provider `params` or runtime modelParams) always win — we only
 * fill gaps.
 *
 * - Reasoning models get `thinking: {type:"enabled"}` + `reasoning_effort:
 *   "medium"` (ZCode uses "max"; medium balances cost/latency — override
 *   via config params if desired).
 * - All models get a `max_tokens` floor of 16384 when unset, so thinking
 *   output isn't truncated by a small provider default.
 *
 * Global kill-switch: `OCTOPUS_ENABLE_THINKING=0` disables the thinking
 * injection (max_tokens floor still applies).
 */
function _resolveInferenceDefaults(
  modelName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const thinkingEnabled = process.env.OCTOPUS_ENABLE_THINKING !== "0";
  const defaults: Record<string, unknown> = {};

  if (params["max_tokens"] === undefined) {
    defaults["max_tokens"] = 16384;
  }

  if (
    thinkingEnabled &&
    params["thinking"] === undefined &&
    _isReasoningModel(modelName)
  ) {
    defaults["thinking"] = { type: "enabled" };
    if (params["reasoning_effort"] === undefined) {
      defaults["reasoning_effort"] = "medium";
    }
  }

  return defaults;
}

// =============================================================================
// buildChatModel — public alias for the internal model constructor.
//
// Exposed so non-graph callers (e.g. title generation) can reuse the same
// config.toml / provider-override / env-var resolution logic without spinning
// up a full LangGraph deepagents graph.
// =============================================================================

/**
 * Build a standalone LangChain chat model from a `provider:model` spec.
 *
 * Reuses the same `_buildChatModel` that `makeGraph` uses internally, so the
 * provider config (base_url, api_key_env, params) resolution is identical.
 * Unlike `makeGraph`, this does NOT attach a checkpointer, tools, or the
 * deepagents middleware stack — it returns a bare `BaseChatModel` you can call
 * `.invoke()` / `.stream()` on directly.
 */
export async function buildChatModel(
  modelSpec: string,
  providerOverrides?: Record<string, { baseUrl?: string; apiKeyEnv?: string; apiKey?: string }>,
): Promise<any> {
  const { model } = await _buildChatModel(modelSpec, providerOverrides);
  return model;
}

// =============================================================================
// generateTitle — auto-summarize a conversation title from the first user turn.
//
// Equivalent to the Python project's frontend-driven title generation
// (ui/web/src/apis/agent_api.js generateTitle + AgentChatComponent.vue
// orchestration), moved server-side into core so the web client doesn't need
// a separate /call round-trip.
//
// - Uses a single non-streaming model.invoke([HumanMessage]) call.
// - Prompt asks for ≤30 chars, no markdown.
// - Output is truncated to 30 chars and whitespace-collapsed.
// - Returns null on any failure so callers can fall back to a truncated user msg.
// =============================================================================

/** Max title length (characters), matching the reference implementation. */
export const TITLE_MAX_LENGTH = 30;

/**
 * Resolve the model spec for title generation.
 * Priority: env `OCTOPUS_TITLE_MODEL` > config.json `models.title_model` > null
 * (caller falls back to the main model spec).
 * Mirrors opencode's `provider.getSmallModel` semantics.
 */
export function getTitleModelSpec(): string | null {
  const env = process.env["OCTOPUS_TITLE_MODEL"] ?? process.env["DEEPAGENTS_CODE_TITLE_MODEL"];
  if (env) return env;
  try {
    return ModelConfig.load().title_model ?? null;
  } catch {
    return null;
  }
}

/**
 * Generate a short conversation title from the user's first message.
 *
 * @param userMessage  The user's first turn text (truncated to 2000 chars internally).
 * @param modelSpec    A `provider:model` spec; resolved via the same config.toml
 *                     rules as the main agent model. Used as fallback when no
 *                     dedicated title model is configured.
 * @returns The generated title (≤30 chars), or `null` if generation failed.
 */
export async function generateTitle(
  userMessage: string,
  modelSpec?: string,
): Promise<string | null> {
  const titleLogger = getLogger("agent.title");
  // Match the reference: cap the prompt input at 2000 chars.
  const snippet = userMessage.replace(/\s+/g, " ").trim().slice(0, 2000);

  const prompt =
    `根据以下对话内容生成一个简短的标题（最多30个字符，中英文均可），` +
    `不要包含 markdown 标记：\n\n${snippet}`;

  const spec = getTitleModelSpec() ?? modelSpec;
  if (!spec) {
    titleLogger.debug("No model spec available for title generation");
    return null;
  }

  try {
    const model = await buildChatModel(spec);
    const { HumanMessage } = await import("@langchain/core/messages");
    const res = await model.invoke([new HumanMessage(prompt)]);
    const raw: string =
      typeof res?.content === "string"
        ? res.content
        : Array.isArray(res?.content)
          ? res.content
              .map((b: any) => (b?.type === "text" ? b.text : ""))
              .join("")
          : "";
    const title = raw.slice(0, TITLE_MAX_LENGTH).replace(/\s+/g, " ").trim();
    titleLogger.debug(`Generated title "${title}" from snippet (${snippet.length} chars)`);
    return title || null;
  } catch (err) {
    titleLogger.exception("Title generation failed", err);
    return null;
  }
}
