/**
 * Model settings service — model-provider + general-settings management.
 *
 * Reads/writes ~/.deepagents/config.json via core's ModelConfig facade and
 * writers. Never surfaces raw API key values to the caller; only a
 * `hasCredentials` boolean and the canonical env-var name.
 *
 * General settings (tool toggles) are persisted to config.json `settings.tools`
 * so user intent survives restarts. NOTE: the agent runtime currently reads
 * `OCTOPUS_*` env vars as the source of truth (see core/src/config.ts
 * `fromEnvironment`). This service returns the *effective* value (env wins
 * over config) for display; wiring config.json back into the agent graph is a
 * future iteration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ModelConfig,
  listProvidersOverview,
  saveProviderConfig,
  saveDefaultModel,
  clearCaches,
  getSandboxConfig,
  saveSandboxConfig,
  sandboxHasCredentials,
  DEFAULT_CONFIG_PATH,
  type ProviderOverview,
  type ProviderConfig,
  type ProviderConfigPatch,
  type SandboxConfig,
} from "@octopus/core";

// =============================================================================
// Types
// =============================================================================

export interface ModelProviderEntry {
  name: string;
  /** Friendly display name (falls back to `name`). */
  displayName: string;
  /** Protocol/SDK type if set, else null. */
  apiType: string | null;
  enabled: boolean;
  hasCredentials: boolean | null;
  apiKeyEnv: string | null;
  baseUrl: string | null;
  models: string[];
  /** Whether this provider is in the built-in registry (vs user-defined). */
  builtIn: boolean;
}

export interface ModelSettingsResponse {
  providers: ModelProviderEntry[];
  default_model: string | null;
}

export interface ModelProviderDetail extends ModelProviderEntry {
  /** Whether a literal api_key value is stored in config.json (never the value). */
  hasApiKeyLiteral: boolean;
}

/** A model discovered from a provider's live `/models` endpoint. */
export interface RemoteModel {
  id: string;
  displayName: string;
  type: "chat" | "embedding" | "rerank";
  contextLength: number | null;
}

/** Error fetching remote models — carries an HTTP status hint for the router. */
export class RemoteFetchError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface GeneralTools {
  enableShell?: boolean;
  enableWebSearch?: boolean;
  interactive?: boolean;
  autoApprove?: boolean;
}

export interface SystemInfo {
  configPath: string;
  defaultModel: string | null;
  providersCount: number;
  nodeVersion: string;
  platform: string;
}

export interface GeneralSettingsResponse {
  /** Persisted user intent (from config.json `settings.tools`). */
  tools: GeneralTools;
  /** Effective values — env var wins over config when set. */
  effective: GeneralTools;
  system_info: SystemInfo;
}

// =============================================================================
// Model providers
// =============================================================================

function overviewToEntry(row: ProviderOverview): ModelProviderEntry {
  return {
    name: row.name,
    displayName: row.displayName,
    apiType: row.apiType,
    enabled: row.enabled,
    hasCredentials: row.hasCredentials === undefined ? null : row.hasCredentials,
    apiKeyEnv: row.apiKeyEnv ?? null,
    baseUrl: row.baseUrl ?? null,
    models: row.models,
    builtIn: row.builtIn,
  };
}

export function listModelProviders(): ModelSettingsResponse {
  const overview = listProvidersOverview();
  const defaultModel = ModelConfig.load().default_model ?? null;
  return {
    providers: overview.map(overviewToEntry),
    default_model: defaultModel,
  };
}

export function getModelProviderDetail(name: string): ModelProviderDetail | null {
  const overview = listProvidersOverview().find((p) => p.name === name);
  if (!overview) return null;
  const provider: ProviderConfig | undefined = ModelConfig.load().providers[name];
  return {
    ...overviewToEntry(overview),
    hasApiKeyLiteral: Boolean(provider?.api_key),
  };
}

export function setDefaultModel(spec: string): { default_model: string } {
  if (!spec || typeof spec !== "string" || !spec.includes(":")) {
    throw new Error("模型规格必须为 `provider:model` 格式");
  }
  const ok = saveDefaultModel(spec);
  if (!ok) throw new Error("无法写入 config.json");
  return { default_model: spec };
}

export function updateModelProvider(name: string, patch: ProviderConfigPatch): ModelProviderEntry {
  if (!name) throw new Error("缺少 provider 名称");
  const finalKey = saveProviderConfig(name, patch);
  const row = listProvidersOverview().find((p) => p.name === finalKey);
  if (!row) throw new Error(`provider ${finalKey} 不存在`);
  return overviewToEntry(row);
}

export function setModelProviderEnabled(name: string, enabled: boolean): { enabled: boolean } {
  updateModelProvider(name, { enabled });
  return { enabled };
}

// =============================================================================
// Remote model discovery (live provider /models probe)
// =============================================================================
//
// Calls the provider's models endpoint to enumerate models it actually serves.
// Discriminates the endpoint path + auth + response parser by `api_type`
// (falling back to the provider key when api_type is unset):
//   - openai / openai-compatible / deepseek / openrouter / ... → OpenAI shape
//   - anthropic                                          → Anthropic shape
//   - ollama                                             → Ollama shape
// Never persisted — the caller adds chosen ids to config.json explicitly.

const FETCH_TIMEOUT_MS = 30_000;

/** Resolve the protocol family for a provider (api_type wins, else the key). */
function resolveApiType(name: string): string {
  const overview = listProvidersOverview().find((p) => p.name === name);
  return (overview?.apiType ?? name).toLowerCase();
}

/** Build the models-list URL + auth headers for a provider. */
function buildModelsRequest(name: string): { url: string; headers: Record<string, string> } {
  const apiType = resolveApiType(name);
  const baseUrl = ModelConfig.getBaseUrl(name);
  const apiKey = ModelConfig.getApiKey(name);
  const headers: Record<string, string> = { Accept: "application/json" };

  if (!baseUrl) {
    // Fall back to well-known defaults for a few providers when nothing is set.
    const fallback: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      deepseek: "https://api.deepseek.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
    };
    const fb = fallback[apiType];
    if (!fb) {
      throw new RemoteFetchError(
        `未配置 ${name} 的 Base URL，无法获取远端模型`,
        400,
      );
    }
    return finalize(apiType, fb, apiKey, headers);
  }
  return finalize(apiType, baseUrl.replace(/\/+$/, ""), apiKey, headers);
}

function finalize(
  apiType: string,
  base: string,
  apiKey: string | undefined,
  headers: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  switch (apiType) {
    case "ollama":
      return { url: `${base}/api/tags`, headers };
    case "anthropic": {
      if (apiKey) {
        headers["x-api-key"] = apiKey;
      }
      headers["anthropic-version"] = "2023-06-01";
      return { url: `${base}/models`, headers };
    }
    default: {
      // OpenAI-compatible family.
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      // Honor the configured base exactly: hit {base}/models. Most bases
      // already include the /v1 segment (e.g. https://api.openai.com/v1).
      return { url: `${base}/models`, headers };
    }
  }
}

/** Parse a fetched payload into normalized RemoteModel rows. */
function parseModelsPayload(
  payload: unknown,
  apiType: string,
): RemoteModel[] {
  const out: RemoteModel[] = [];
  const push = (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return;
    const obj = raw as Record<string, unknown>;
    // OpenAI/Ollama: `id`. Anthropic: `id`. Ollama also exposes `name`.
    const id = String(obj["id"] ?? obj["name"] ?? "").trim();
    if (!id) return;
    out.push({
      id,
      displayName: String(obj["name"] ?? obj["display_name"] ?? id),
      type: normalizeType(obj["type"], apiType),
      contextLength: toInt(obj["context_length"]),
    });
  };

  if (apiType === "ollama") {
    const models = (payload as Record<string, unknown>)?.["models"];
    if (Array.isArray(models)) models.forEach(push);
    return out;
  }

  // OpenAI / Anthropic / OpenRouter: { data: [...] } OR a bare array.
  const data = (payload as Record<string, unknown>)?.["data"];
  if (Array.isArray(data)) {
    data.forEach(push);
  } else if (Array.isArray(payload)) {
    payload.forEach(push);
  }
  return out;
}

function normalizeType(
  raw: unknown,
  apiType: string,
): "chat" | "embedding" | "rerank" {
  if (raw === "embedding" || raw === "rerank") return raw;
  // Anthropic returns type "model"; treat as chat.
  if (apiType === "anthropic") return "chat";
  return "chat";
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Fetch the live model list from a provider. Never persisted. Throws
 * `RemoteFetchError` (with an HTTP status hint) on failure.
 */
export async function fetchRemoteModels(name: string): Promise<RemoteModel[]> {
  if (!name) throw new RemoteFetchError("缺少 provider 名称", 400);
  const overview = listProvidersOverview().find((p) => p.name === name);
  if (!overview) throw new RemoteFetchError(`供应商 ${name} 不存在`, 404);

  const apiType = resolveApiType(name);
  const { url, headers } = buildModelsRequest(name);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    throw new RemoteFetchError(
      `无法连接到 ${name}（${url}）：${(err as Error).message}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new RemoteFetchError("远端 API 认证失败，请检查 API Key 配置", 502);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RemoteFetchError(
      `${name} 返回 ${res.status}：${body.slice(0, 200)}`,
      res.status >= 400 && res.status < 500 ? res.status : 502,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new RemoteFetchError(`${name} 返回了非 JSON 响应`, 502);
  }

  const models = parseModelsPayload(payload, apiType);
  // Dedupe by id (keep first occurrence).
  const seen = new Set<string>();
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

// =============================================================================
// General settings (tool toggles)
// =============================================================================

const TOOL_KEYS: (keyof GeneralTools)[] = [
  "enableShell",
  "enableWebSearch",
  "interactive",
  "autoApprove",
];

function readConfigJson(): Record<string, unknown> {
  try {
    if (existsSync(DEFAULT_CONFIG_PATH)) {
      return JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));
    }
  } catch {
    // invalid JSON → start fresh
  }
  return {};
}

function writeConfigJson(data: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    const tmp = join(
      dirname(DEFAULT_CONFIG_PATH),
      `.${basename(DEFAULT_CONFIG_PATH)}.tmp.${Date.now()}`,
    );
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, DEFAULT_CONFIG_PATH);
    clearCaches();
  } catch (err) {
    throw new Error(`无法写入 config.json: ${String(err)}`);
  }
}

function readPersistedTools(): GeneralTools {
  const data = readConfigJson();
  const settings = (data["settings"] ?? {}) as Record<string, unknown>;
  const tools = (settings["tools"] ?? {}) as Record<string, unknown>;
  const out: GeneralTools = {};
  for (const key of TOOL_KEYS) {
    if (typeof tools[key] === "boolean") out[key] = tools[key] as boolean;
  }
  return out;
}

/** Env wins over persisted config — matches `fromEnvironment` precedence. */
function computeEffective(persisted: GeneralTools): GeneralTools {
  const envSet = (name: string): boolean | undefined =>
    name in process.env ? process.env[name] !== "false" : undefined;
  return {
    enableShell: envSet("OCTOPUS_ENABLE_SHELL") ?? persisted.enableShell ?? true,
    enableWebSearch:
      envSet("OCTOPUS_ENABLE_WEB_SEARCH") ?? persisted.enableWebSearch ?? true,
    interactive: envSet("OCTOPUS_INTERACTIVE") ?? persisted.interactive ?? true,
    autoApprove: envSet("OCTOPUS_AUTO_APPROVE")
      ? process.env["OCTOPUS_AUTO_APPROVE"] === "true"
      : (persisted.autoApprove ?? false),
  };
}

export function getGeneralSettings(): GeneralSettingsResponse {
  const persisted = readPersistedTools();
  const providersCount = listProvidersOverview().length;
  return {
    tools: persisted,
    effective: computeEffective(persisted),
    system_info: {
      configPath: DEFAULT_CONFIG_PATH,
      defaultModel: ModelConfig.load().default_model ?? null,
      providersCount,
      nodeVersion: process.version,
      platform: process.platform,
    },
  };
}

export function updateGeneralSettings(patch: GeneralTools): GeneralSettingsResponse {
  const data = readConfigJson();
  const settings = ((data["settings"] ?? {}) as Record<string, unknown>);
  const tools = ((settings["tools"] ?? {}) as Record<string, unknown>);
  for (const key of TOOL_KEYS) {
    if (typeof patch[key] === "boolean") {
      tools[key] = patch[key];
    }
  }
  settings["tools"] = tools;
  data["settings"] = settings;
  writeConfigJson(data);
  return getGeneralSettings();
}

// =============================================================================
// Sandbox settings — config.json `sandbox` section.
//
// Powers the 常规设置 sandbox config area. Credentials are write-only: the
// literal api_key is stored in config.json but only a hasCredentials boolean is
// surfaced to clients (mirrors the model-provider key convention).
// =============================================================================

export interface SandboxSettingsResponse {
  enabled: boolean;
  provider: "langsmith";
  hasCredentials: boolean;
  apiKeyEnv: string | null;
  templateName: string | null;
  snapshotId: string | null;
}

export interface SandboxSettingsPatch {
  enabled?: boolean;
  provider?: "langsmith";
  /** Write-only — set to "" to clear the literal key. */
  apiKey?: string;
  apiKeyEnv?: string | null;
  templateName?: string | null;
  snapshotId?: string | null;
}

export function getSandboxSettings(): SandboxSettingsResponse {
  const cfg = getSandboxConfig();
  return {
    enabled: cfg.enabled === true,
    provider: "langsmith",
    hasCredentials: sandboxHasCredentials(cfg),
    apiKeyEnv: cfg.api_key_env ?? null,
    templateName: cfg.template_name ?? null,
    snapshotId: cfg.snapshot_id ?? null,
  };
}

export function updateSandboxSettings(patch: SandboxSettingsPatch): SandboxSettingsResponse {
  const mapped: SandboxConfig = {};
  if (typeof patch.enabled === "boolean") mapped.enabled = patch.enabled;
  if (patch.provider) mapped.provider = patch.provider;
  if (typeof patch.apiKey === "string") mapped.api_key = patch.apiKey;
  if (patch.apiKeyEnv !== undefined) mapped.api_key_env = patch.apiKeyEnv ?? undefined;
  if (patch.templateName !== undefined) mapped.template_name = patch.templateName ?? undefined;
  if (patch.snapshotId !== undefined) mapped.snapshot_id = patch.snapshotId ?? undefined;
  saveSandboxConfig(mapped);
  clearCaches();
  return getSandboxSettings();
}
