// =============================================================================
// Auth store — securely persists API keys to ~/.deepagents/.state/auth.json.
// Equivalent to Python tui.auth_store.
//
// Uses atomic writes (temp file + rename) and validates permissions.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

// =============================================================================
// Types
// =============================================================================

export interface StoredCredential {
  /** The API key value. */
  api_key: string;
  /** Optional base URL paired with this key. */
  base_url?: string;
  /** When this credential was stored. */
  stored_at: string;
  /** Provider name. */
  provider: string;
}

export interface AuthStore {
  credentials: Record<string, StoredCredential>;
}

// =============================================================================
// Path resolution
// =============================================================================

const AUTH_STORE_PATH = join(homedir(), ".deepagents", ".state", "auth.json");

function ensureDir(): void {
  const dir = dirname(AUTH_STORE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// Load / save
// =============================================================================

/**
 * Load all stored credentials.
 * Equivalent to Python `load_credentials()`.
 */
export function loadCredentials(): Record<string, StoredCredential> {
  try {
    const raw = readFileSync(AUTH_STORE_PATH, "utf-8");
    const store = JSON.parse(raw) as AuthStore;
    return store.credentials ?? {};
  } catch {
    return {};
  }
}

/**
 * Get a stored API key for a provider.
 * Equivalent to Python `get_stored_key()`.
 */
export function getStoredKey(provider: string): string | null {
  const creds = loadCredentials();
  return creds[provider]?.api_key ?? null;
}

/**
 * Get the stored base URL for a provider.
 */
export function getStoredBaseUrl(provider: string): string | null {
  const creds = loadCredentials();
  return creds[provider]?.base_url ?? null;
}

/**
 * Store an API key for a provider.
 * Equivalent to Python `set_stored_key()`.
 */
export function setStoredKey(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): void {
  ensureDir();

  const creds = loadCredentials();
  creds[provider] = {
    api_key: apiKey,
    base_url: baseUrl,
    stored_at: new Date().toISOString(),
    provider,
  };

  atomicWrite(AUTH_STORE_PATH, JSON.stringify({ credentials: creds }, null, 2));
}

/**
 * Delete a stored credential.
 * Equivalent to Python `delete_stored_key()`.
 */
export function deleteStoredKey(provider: string): boolean {
  const creds = loadCredentials();
  if (!creds[provider]) return false;

  delete creds[provider];
  atomicWrite(AUTH_STORE_PATH, JSON.stringify({ credentials: creds }, null, 2));
  return true;
}

/**
 * List all providers with stored credentials.
 */
export function listConfiguredProviders(): string[] {
  return Object.keys(loadCredentials()).sort();
}

// =============================================================================
// Atomic write helper
// =============================================================================

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");

  // Set restrictive permissions on Unix
  if (platform() !== "win32") {
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      /* best effort */
    }
  }

  renameSync(tmpPath, filePath);
}
