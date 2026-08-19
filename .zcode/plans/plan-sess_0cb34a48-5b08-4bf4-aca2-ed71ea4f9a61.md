# Plan: Model Settings Feature (Octopus)

Implement a routed **Settings** panel with two menus — **常规 (General)** and **模型配置 (Model Configuration)** — entered from the sidebar's settings gear, mirroring the yuxi reference's concept but built on Octopus's existing Extensions pattern (React 19 + Zustand + React Router + Ant Design). Full stack: real config.json-backed backend + tentacle client + new routed UI. Replaces the per-chat `AgentConfigSidebar` drawer (gear icon repurposed to navigate to `/settings/general`).

---

## Part 1 — Core: expose model-config helpers (`@octopus/core`)

`core/src/model_config.ts` already has the read facade (`ModelConfig.load`, `getApiKey`, `getBaseUrl`, `hasCredentials`, `isProviderEnabled`, `PROVIDER_API_KEY_ENV`) and writers (`saveDefaultModel`, `saveRecentModel`). **Add small pure helpers** here so the server stays thin:

- `listProvidersOverview()` → returns `{ name, enabled, hasCredentials: boolean|undefined, baseUrl?, apiKeyEnv?, models[] }[]` by iterating `PROVIDER_API_KEY_ENV` (the known-provider universe) merged with `ModelConfig.load().providers`.
- `saveProviderConfig(providerName, { enabled?, apiKey?, apiKeyEnv?, baseUrl?, models? })` → read-modify-write `config.json` `models.providers.<name>` (reuse existing `_readConfigOrEmpty` / `_writeConfig`; export them or add a sibling writer). Always `clearCaches()` after write.
- Add `default_model` getter already covered by `ModelConfig.load().default_model`.

Export new symbols from `core/src/index.ts` alongside the existing `ModelConfig`, `saveDefaultModel`, `PROVIDER_API_KEY_ENV`, `PROVIDER_BASE_URL_ENV`, `clearCaches`.

## Part 2 — Server: `/api/config/models` + `/api/config/settings`

Add a new `server/src/services/model.service.ts` mirroring `subagent.service.ts`'s shape (sync functions, `getOptionalUser`-aware, `getLogger`). Methods:

- `listModelProviders()` → calls `listProvidersOverview()`; never returns raw API key values (return `hasCredentials` boolean + masked `apiKeyEnv`, never the resolved secret).
- `getModelProviderDetail(name)` → single provider with config (api_key masked as `"***"` or omitted, base_url, models, enabled).
- `setDefaultModel(spec)` → `saveDefaultModel(spec)`; returns `{ default_model }`.
- `updateProvider(name, patch)` → `saveProviderConfig(name, patch)`.
- `setProviderEnabled(name, enabled)` → convenience wrapper.
- `getGeneralSettings()` / `updateGeneralSettings(patch)` → read/write `OCTOPUS_*` tool toggles. Since these are process env (read-only at runtime), persist user overrides to `config.json` under a new `settings.tools` section `{ enableShell, enableWebSearch, interactive, autoApprove, enableMcp }`. The agent config loader already reads `OCTOPUS_*` env; we add a small precedence note (env wins over config for now; document this in code comment). For Phase 1, **persist to config.json only** and surface current effective values (env-or-config) for display.

Register in `server/src/routes/config.ts` (no `app.ts` change — `/api/config` already mounted):

```
GET    /api/config/models                      → { providers, default_model }
GET    /api/config/models/:name                → provider detail
PUT    /api/config/models/default              → { default_model }
PUT    /api/config/models/:name                → updated provider
PUT    /api/config/models/:name/enabled        → { enabled }
GET    /api/config/settings                    → { tools, system_info }
PUT    /api/config/settings                    → updated tools
```

Use the existing `getOptionalUser` middleware and `handleError` helper. Add `getMe`-style account info by reusing existing `authRouter`'s `/api/auth/me` (no new endpoint needed — the client already has `getMe()`).

`system_info` payload: `{ configPath, defaultModel, nodeVersion, platform, providersCount }` (read-only).

## Part 3 — Tentacle: typed client methods + Zod types

`tentacle/src/types.ts` — add after the Subagents section:

```ts
export const ModelProviderEntry = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  hasCredentials: z.boolean().nullable(),
  apiKeyEnv: z.string().nullable(),
  baseUrl: z.string().nullable(),
  models: z.array(z.string()).default([]),
});
export const ModelSettingsResponse = z.object({
  providers: z.array(ModelProviderEntry),
  default_model: z.string().nullable(),
});
export const GeneralTools = z.object({
  enableShell: z.boolean().optional(),
  enableWebSearch: z.boolean().optional(),
  enableMcp: z.boolean().optional(),
  interactive: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
});
export const GeneralSettingsResponse = z.object({
  tools: GeneralTools, system_info: z.record(z.unknown()),
});
```

`tentacle/src/client.ts` — add a **Settings** method group mirroring the Subagents group:
- `listModelSettings()` → GET `/api/config/models`
- `getModelProvider(name)` → GET `/api/config/models/:name`
- `setDefaultModel(spec)` → PUT `/api/config/models/default`
- `updateModelProvider(name, patch)` → PUT `/api/config/models/:name`
- `setModelProviderEnabled(name, enabled)` → PUT `/api/config/models/:name/enabled`
- `getGeneralSettings()` → GET `/api/config/settings`
- `updateGeneralSettings(tools)` → PUT `/api/config/settings`

## Part 4 — Web: routed Settings panel

### Routing & layout switch
- `web/src/App.tsx` — add under `<AppLayout />`:
  ```
  <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
  <Route path="/settings/general" element={<SettingsPage tab="general" />} />
  <Route path="/settings/model" element={<SettingsPage tab="model" />} />
  ```
- `web/src/layouts/AppLayout.tsx` — extend the sidebar switch:
  ```tsx
  const isSettings = location.pathname.startsWith("/settings");
  {isSettings ? <SettingsSidebar /> : isExtensions ? <ExtensionsSidebar /> : <Sidebar />}
  ```

### New `web/src/components/SettingsSidebar.tsx` — clone of `ExtensionsSidebar.tsx`
- `返回对话` button → `navigate("/")`.
- Section label "设置".
- `MENU_ITEMS`: `{ key:"general", path:"/settings/general", icon:<SettingOutlined/>, label:"常规" }` and `{ key:"model", path:"/settings/model", icon:<RobotOutlined/>, label:"模型配置" }`.
- Active-key derivation from path (same pattern).

### New `web/src/pages/SettingsPage.tsx` — page component (mirrors `Extensions.tsx` layout)
- Header strip at `--header-height: 45px` with title (常规 / 模型配置).
- Scrollable content.
- **General tab** (`GeneralSettingsSection.tsx`):
  - **工具开关** cards: `Switch` for Shell / 网页搜索 / MCP / 交互确认 / 自动批准 — wired to `getGeneralSettings` + `updateGeneralSettings` (optimistic local state, save on toggle).
  - **账户 / 用户资料** card: avatar + username + role from existing `getMe()` client call; "退出登录" button clears token + navigates to `/`.
  - **系统信息 / 关于** card: read-only list from `system_info` (config path, default model, provider count, platform, version).
- **Model tab** (`ModelSettingsSection.tsx`):
  - **默认模型** Select at top (options = union of all providers' models as `"provider:model"`), bound to `default_model` via `setDefaultModel`.
  - **Provider list** — one card per provider (like yuxi `InfoCard`): name, enabled `Switch`, credential status `Tag` (success/warning based on `hasCredentials`), base URL text, models count. Expand/collapse to show models list and an edit form (API key `Input.Password` — write-only, placeholder "已配置"/"未配置"; base URL `Input`; api_key_env `Input`; models multi-`Select` in tag mode). Save button → `updateModelProvider`.
  - No remote-model fetching in Phase 1 (yuxi's `fetchRemoteModels` requires live provider calls — out of scope; users edit model lists manually).

### Replacing the existing drawer
- `web/src/components/Sidebar.tsx` line 306-316: change the gear `SettingOutlined` `onClick` from `setConfigOpen(true)` to `navigate("/settings/general")`. Add `useNavigate` import. Remove the now-unused `configOpen`/`setConfigOpen` usage from Sidebar (leave store fields intact for now — minimal churn).
- `web/src/pages/Chat.tsx` line 610: remove the `<AgentConfigSidebar>` mount and its `configOpen` read (line 45). Migrate any unique fields (temperature, max tokens, system prompt) → defer; per-chat overrides were non-persistent stubs, so dropping them is acceptable. Leave a code comment noting migration.
- **Delete** `web/src/components/AgentConfigSidebar.tsx` (replaced by the routed page). Per AGENTS.md "look at the target — surface contradictions": this file is the existing settings entry; replacing it is the explicit user choice.

### Zustand store
- `configOpen`/`setConfigOpen` in `web/src/stores/chat.ts`: leave in place (harmless) or remove if no other consumers. I'll verify with grep and remove only if zero references remain after edits.

## Part 5 — Build/typecheck order
Per AGENTS.md: build `core` → `tentacle` → `server`/`web`. Verify each with `tsc --noEmit` (the project's lint). No tests exist; do not invent test commands. Ensure `clearCaches()` is called after any `saveProviderConfig`/`saveDefaultModel` (writers already invalidate the cache via `_writeConfig`).

---

## Files touched

**New:**
- `web/src/components/SettingsSidebar.tsx`
- `web/src/pages/SettingsPage.tsx`
- `web/src/components/settings/GeneralSettingsSection.tsx`
- `web/src/components/settings/ModelSettingsSection.tsx`
- `server/src/services/model.service.ts`

**Modified:**
- `core/src/model_config.ts` (add `listProvidersOverview`, `saveProviderConfig`, export helpers)
- `core/src/index.ts` (export new symbols)
- `server/src/routes/config.ts` (add `/models` + `/settings` sections)
- `tentacle/src/types.ts` (model + settings Zod types)
- `tentacle/src/client.ts` (Settings method group)
- `web/src/App.tsx` (3 routes)
- `web/src/layouts/AppLayout.tsx` (sidebar switch)
- `web/src/components/Sidebar.tsx` (gear → navigate)
- `web/src/pages/Chat.tsx` (remove drawer mount)

**Deleted:**
- `web/src/components/AgentConfigSidebar.tsx`

## Notes / open assumptions
- API keys are **never** returned to the client (write-only `Input.Password`); only `hasCredentials` boolean. This matches security norms and AGENTS.md's "Never commit API keys" caution.
- `OCTOPUS_*` env toggles remain the runtime source of truth for the agent; the General tab persists user intent to `config.json` `settings.tools` and surfaces the *effective* value. Full env-override wiring into the agent graph is deferred (would need config-loader changes); Phase 1 persists + displays.
- No remote model fetching in Phase 1 (manual model list editing only) — yuxi's live provider probing is a larger feature.
- User-facing strings in Chinese (常规, 模型配置, 返回对话, 工具开关, 账户, 系统信息) per AGENTS.md convention.