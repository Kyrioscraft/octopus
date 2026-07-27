import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Select, Input, Button, Spin, Empty, Tooltip, Modal, Switch, Tag, List, Skeleton,
  message as antdMessage, Popconfirm,
} from "antd";
import {
  ReloadOutlined, PlusOutlined, SearchOutlined, CloudOutlined,
  SettingOutlined, DeleteOutlined, ApiOutlined, AppstoreOutlined,
  CheckCircleFilled,
} from "@ant-design/icons";
import type {
  OctopusClient,
  ModelSettingsResponse,
  ModelProviderEntry,
  ModelProviderPatch,
  RemoteModel,
} from "@octopus/tentacle";

interface Props {
  sdk: OctopusClient;
}

/**
 * Model configuration section — a single card listing providers as rows
 * (reuses the General-section tool-toggle row layout). Each row carries an
 * enable switch + a 模型管理 button + a 配置 button.
 *
 *   - 模型管理 modal: get + add/remove models only.
 *   - 配置 modal: provider attributes only (api key, api key env, base url).
 *
 * API keys are write-only — the backend never returns the literal value,
 * only a `hasCredentials` boolean.
 */
export function ModelSettingsSection({ sdk }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ModelSettingsResponse | null>(null);
  const [search, setSearch] = useState("");
  // Which modal is open for a given provider, if any.
  const [modelsFor, setModelsFor] = useState<ModelProviderEntry | null>(null);
  const [configFor, setConfigFor] = useState<ModelProviderEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await sdk.listModelSettings());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sdk]);

  useEffect(() => {
    load();
  }, [load]);

  const setDefault = async (spec: string) => {
    if (!data) return;
    const prev = data.default_model;
    setData({ ...data, default_model: spec });
    try {
      await sdk.setDefaultModel(spec);
      antdMessage.success("默认模型已更新");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
      setData({ ...data, default_model: prev });
    }
  };

  // Sort: enabled first → credential warning sinks → alphabetical.
  const providers = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return [...data.providers]
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const aw = a.enabled && a.hasCredentials === false ? 1 : 0;
        const bw = b.enabled && b.hasCredentials === false ? 1 : 0;
        if (aw !== bw) return aw - bw;
        return a.name.localeCompare(b.name);
      });
  }, [data, search]);

  const toggleEnabled = async (provider: ModelProviderEntry, value: boolean) => {
    // Optimistic update of the local list.
    if (data) {
      setData({
        ...data,
        providers: data.providers.map((p) =>
          p.name === provider.name ? { ...p, enabled: value } : p,
        ),
      });
    }
    try {
      await sdk.setModelProviderEnabled(provider.name, value);
      antdMessage.success(value ? "已启用" : "已禁用");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
      load();
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
        <Spin />
      </div>
    );
  }
  if (!data) {
    return <div style={{ color: "var(--gray-500)", padding: 40, textAlign: "center" }}>加载失败</div>;
  }

  const modelOptions = Array.from(
    new Set(data.providers.flatMap((p) => p.models.map((m) => `${p.name}:${m}`))),
  ).map((spec) => ({ value: spec, label: spec }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Default model selector */}
      <Card title="默认模型">
        <div style={{ fontSize: 12, color: "var(--gray-500)", marginBottom: 10 }}>
          新建对话使用的默认模型（格式 <code>provider:model</code>）。需先在下方供应商中配置对应模型。
        </div>
        <Select
          showSearch
          style={{ width: "100%", maxWidth: 420 }}
          placeholder="选择默认模型"
          value={data.default_model ?? undefined}
          options={modelOptions}
          onChange={setDefault}
          notFoundContent="暂无可用模型，请在下方供应商中添加"
        />
      </Card>

      {/* Provider list (row card — same layout as General tool toggles) */}
      <Card
        title="模型供应商"
        extra={
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--gray-400)" }} />}
            placeholder="搜索供应商..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220, borderRadius: 8 }}
          />
        }
      >
        {providers.length === 0 ? (
          <Empty description={search ? "无匹配供应商" : "暂无供应商"} style={{ padding: "20px 0" }} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {providers.map((p) => (
              <ProviderRow
                key={p.name}
                provider={p}
                onToggle={(v) => toggleEnabled(p, v)}
                onManageModels={() => setModelsFor(p)}
                onConfig={() => setConfigFor(p)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Models management modal (get + add/remove only) */}
      {modelsFor && (
        <ModelsModal
          provider={modelsFor}
          sdk={sdk}
          onClose={() => setModelsFor(null)}
          onSaved={load}
        />
      )}

      {/* Provider config modal (attributes only) */}
      {configFor && (
        <ConfigModal
          provider={configFor}
          sdk={sdk}
          onClose={() => setConfigFor(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

// =============================================================================
// Provider row (mirrors the General tool-toggle row layout)
// =============================================================================

function ProviderRow({
  provider, onToggle, onManageModels, onConfig,
}: {
  provider: ModelProviderEntry;
  onToggle: (value: boolean) => void;
  onManageModels: () => void;
  onConfig: () => void;
}) {
  const disabled = !provider.enabled;
  const warning = provider.enabled && provider.hasCredentials === false;

  // Credential hint shown inline.
  const credHint =
    provider.hasCredentials === null
      ? "凭据未知"
      : provider.hasCredentials
        ? "已配置凭据"
        : "未配置凭据";
  const credColor = provider.hasCredentials === false
    ? "var(--color-warning-700)"
    : "var(--gray-500)";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 0",
        borderBottom: "1px solid var(--gray-100)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          fontSize: 18, color: disabled ? "var(--gray-400)" : "var(--main-color)",
          width: 24, textAlign: "center", flexShrink: 0,
        }}
      >
        <ApiOutlined />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--gray-1000)" }}>
          {provider.displayName}
          {provider.displayName !== provider.name && (
            <span style={{ marginInlineStart: 8, fontSize: 12, color: "var(--gray-500)", fontWeight: 400 }}>
              {provider.name}
            </span>
          )}
          <span style={{ marginInlineStart: 8, fontSize: 12, color: credColor, fontWeight: 400 }}>
            {credHint}
            {warning && " · 凭证缺失"}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--gray-500)" }}>
          {provider.apiType ? `${provider.apiType} · ` : ""}
          {provider.models.length} 个模型
        </div>
      </div>
      <Tooltip title="模型管理">
        <Button
          size="small"
          icon={<AppstoreOutlined />}
          onClick={onManageModels}
          style={{ borderRadius: 8 }}
        />
      </Tooltip>
      <Tooltip title="配置">
        <Button
          size="small"
          icon={<SettingOutlined />}
          onClick={onConfig}
          style={{ borderRadius: 8 }}
        />
      </Tooltip>
      <Switch size="small" checked={provider.enabled} onChange={onToggle} />
    </div>
  );
}

// =============================================================================
// Models modal — get + add/remove models only
// =============================================================================

function ModelsModal({
  provider, sdk, onClose, onSaved,
}: {
  provider: ModelProviderEntry;
  sdk: OctopusClient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [models, setModels] = useState<string[]>(provider.models);
  const [newModel, setNewModel] = useState("");
  const [saving, setSaving] = useState(false);
  // Remote model discovery state.
  const [remoteModels, setRemoteModels] = useState<RemoteModel[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteSearch, setRemoteSearch] = useState("");

  // Keep local list in sync if the parent reloads while open.
  useEffect(() => {
    setModels(provider.models);
  }, [provider.models]);

  const persist = async (next: string[], msg: string) => {
    setSaving(true);
    try {
      await sdk.updateModelProvider(provider.name, { models: next });
      setModels(next);
      antdMessage.success(msg);
      onSaved();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    } finally {
      setSaving(false);
    }
  };

  const addModel = () => {
    const id = newModel.trim();
    if (!id) return;
    if (models.includes(id)) {
      antdMessage.warning("模型已存在");
      return;
    }
    void persist([...models, id], "已添加模型");
    setNewModel("");
  };

  const addFromRemote = (id: string) => {
    if (models.includes(id)) return;
    void persist([...models, id], `已添加模型 ${id}`);
  };

  const removeModel = (id: string) => {
    void persist(models.filter((m) => m !== id), "已移除模型");
  };

  const fetchRemote = async () => {
    setRemoteLoading(true);
    try {
      const list = await sdk.fetchRemoteModels(provider.name);
      setRemoteModels(list);
      antdMessage.success(`已获取 ${list.length} 个远端模型`);
    } catch (err: any) {
      antdMessage.error(err?.message ?? "获取远端模型失败");
    } finally {
      setRemoteLoading(false);
    }
  };

  // Filtered remote list (by search query) — matches both id and displayName.
  const filteredRemote = useMemo(() => {
    if (!remoteModels) return [];
    const q = remoteSearch.trim().toLowerCase();
    return remoteModels.filter((m) =>
      !q
      || m.id.toLowerCase().includes(q)
      || (m.displayName ?? "").toLowerCase().includes(q),
    );
  }, [remoteModels, remoteSearch]);

  return (
    <Modal
      open
      title={`${provider.displayName} - 模型管理`}
      width={800}
      onCancel={onClose}
      footer={null}
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Section: enabled models (yuxi-style table) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Section header: title left, add control right */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gray-700)" }}>
              已启用模型 ({models.length})
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Tooltip title="从供应商 API 实时获取可用模型列表">
                <Button
                  size="small"
                  icon={<CloudOutlined />}
                  onClick={fetchRemote}
                  loading={remoteLoading}
                  style={{ borderRadius: 8 }}
                >
                  获取远程模型
                </Button>
              </Tooltip>
              <Input
                size="small"
                placeholder="输入模型 ID 添加"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onPressEnter={addModel}
                style={{ width: 220, borderRadius: 8 }}
              />
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={addModel}
                loading={saving}
                style={{ borderRadius: 8 }}
              >
                手动添加
              </Button>
            </div>
          </div>

          {/* Models table */}
          {models.length === 0 ? (
            <div
              style={{
                border: "1px solid var(--gray-150)", borderRadius: 6,
                padding: "28px 12px", textAlign: "center",
                color: "var(--gray-400)", fontSize: 13,
              }}
            >
              暂无模型，请在右上方添加
            </div>
          ) : (
            <div style={{ border: "1px solid var(--gray-150)", borderRadius: 6, overflow: "hidden" }}>
              {/* Table head */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 110px",
                  gap: 8,
                  padding: "10px 12px",
                  background: "var(--gray-50)",
                  fontSize: 11, fontWeight: 600, color: "var(--gray-500)",
                  textTransform: "uppercase", letterSpacing: "0.5px",
                }}
              >
                <span>模型</span>
                <span style={{ textAlign: "center" }}>操作</span>
              </div>
              {/* Rows */}
              {models.map((m) => (
                <div
                  key={m}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 110px",
                    gap: 8,
                    padding: "10px 12px",
                    borderTop: "1px solid var(--gray-100)",
                    fontSize: 13, alignItems: "center",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-10)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      fontFamily: "ui-monospace, monospace", color: "var(--gray-900)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}
                  >
                    {m}
                  </span>
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <Popconfirm
                      title="移除该模型？"
                      okText="移除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeModel(m)}
                    >
                      <Tooltip title="移除">
                        <Button
                          type="text" size="small" danger
                          icon={<DeleteOutlined />}
                          style={{ width: 28, height: 28, borderRadius: 6 }}
                        />
                      </Tooltip>
                    </Popconfirm>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section: remote candidate models */}
        {remoteLoading && remoteModels === null ? (
          // B1: loading skeleton — shown on first fetch, before any data.
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gray-700)" }}>
                远端候选模型
              </span>
              <span style={{ fontSize: 12, color: "var(--gray-400)" }}>正在拉取…</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 4 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton.Input key={i} active size="small" style={{ width: "100%", height: 20 }} />
              ))}
            </div>
          </div>
        ) : remoteModels !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Header: title + search */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--gray-700)" }}>
                远端候选模型 ({filteredRemote.length})
              </span>
              <Input
                allowClear
                size="small"
                prefix={<SearchOutlined style={{ color: "var(--gray-400)" }} />}
                placeholder="搜索 id 或名称…"
                value={remoteSearch}
                onChange={(e) => setRemoteSearch(e.target.value)}
                style={{ width: 220, borderRadius: 8 }}
              />
            </div>

            {filteredRemote.length === 0 ? (
              // B5: empty state via antd <Empty> (matches the provider list).
              <div
                style={{
                  border: "1px solid var(--gray-150)", borderRadius: 8,
                  padding: "28px 12px",
                }}
              >
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={remoteModels.length === 0 ? "供应商未返回任何模型" : "无匹配模型"}
                  style={{ margin: 0 }}
                />
              </div>
            ) : (
              // B2: bordered card with grid header + List (scrollable).
              <div style={{ border: "1px solid var(--gray-150)", borderRadius: 8, overflow: "hidden" }}>
                {/* Table head — grid aligned with each row below. */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 80px 80px 40px",
                    gap: 8,
                    padding: "10px 12px",
                    background: "var(--gray-50)",
                    fontSize: 11, fontWeight: 600, color: "var(--gray-500)",
                    textTransform: "uppercase", letterSpacing: "0.5px",
                  }}
                >
                  <span>模型</span>
                  <span style={{ textAlign: "center" }}>类型</span>
                  <span style={{ textAlign: "right" }}>上下文</span>
                  <span style={{ textAlign: "center" }}>操作</span>
                </div>
                <List<RemoteModel>
                  split={false}
                  dataSource={filteredRemote}
                  style={{ maxHeight: 360, overflowY: "auto", padding: 0 }}
                  renderItem={(m) => {
                    const added = models.includes(m.id);
                    return (
                      <div
                        key={m.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 80px 80px 40px",
                          gap: 8,
                          padding: "9px 12px",
                          borderTop: "1px solid var(--gray-100)",
                          fontSize: 13, alignItems: "center",
                          transition: "background 0.15s",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-10)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        {/* Model name + id (secondary). */}
                        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                          <span
                            style={{
                              fontWeight: 500, color: "var(--gray-1000)",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}
                          >
                            {m.displayName}
                          </span>
                          {m.displayName !== m.id && (
                            <span
                              style={{
                                fontSize: 11, color: "var(--gray-400)",
                                fontFamily: "ui-monospace, monospace",
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                              }}
                            >
                              {m.id}
                            </span>
                          )}
                        </span>
                        {/* Type tag. */}
                        <span style={{ display: "flex", justifyContent: "center" }}>
                          <TypeTag type={m.type} />
                        </span>
                        {/* Context length. */}
                        <span style={{ color: "var(--gray-500)", fontSize: 12, textAlign: "right" }}>
                          {m.contextLength ? formatContext(m.contextLength) : "—"}
                        </span>
                        {/* Add / added button. */}
                        <span style={{ display: "flex", justifyContent: "center" }}>
                          <Button
                            size="small"
                            type={added ? "primary" : "default"}
                            disabled={added}
                            icon={added ? <CheckCircleFilled /> : <PlusOutlined />}
                            onClick={() => addFromRemote(m.id)}
                            style={{ borderRadius: 8, width: 32, minWidth: 32 }}
                          />
                        </span>
                      </div>
                    );
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Format a context length (tokens) into a compact string. */
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Color-coded type tag matching yuxi's taxonomy. */
function TypeTag({ type }: { type: RemoteModel["type"] }) {
  const palette = {
    chat: { bg: "var(--color-info-50)", color: "var(--color-info-700)" },
    embedding: { bg: "var(--color-success-50)", color: "var(--color-success-700)" },
    rerank: { bg: "var(--color-warning-50)", color: "var(--color-warning-700)" },
  }[type];
  const label = { chat: "Chat", embedding: "Embed", rerank: "Rerank" }[type];
  return (
    <Tag style={{ marginInlineEnd: 0, borderRadius: 4, fontSize: 11, ...palette, border: "none" }}>
      {label}
    </Tag>
  );
}

// =============================================================================
// Config modal — provider attributes only
// =============================================================================

function ConfigModal({
  provider, sdk, onClose, onSaved,
}: {
  provider: ModelProviderEntry;
  sdk: OctopusClient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [displayName, setDisplayName] = useState(provider.displayName ?? "");
  const [apiType, setApiType] = useState(provider.apiType ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      antdMessage.warning("名称不能为空");
      return;
    }
    const patch: ModelProviderPatch = {
      displayName: displayName.trim() || undefined,
      apiType: apiType.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
    };
    // Rename only if the key actually changed.
    if (trimmedName !== provider.name) {
      patch.newName = trimmedName;
    }
    if (apiKey) patch.apiKey = apiKey;
    setSaving(true);
    try {
      await sdk.updateModelProvider(provider.name, patch);
      antdMessage.success("配置已保存");
      setApiKey("");
      onSaved();
      onClose();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={`${provider.displayName} - 配置`}
      width={520}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose} style={{ borderRadius: 8 }}>取消</Button>
          <Button type="primary" loading={saving} onClick={save} style={{ borderRadius: 8 }}>
            保存
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="名称" hint="供应商唯一标识（修改即重命名）">
          <Input
            placeholder="例如 openai"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ borderRadius: 8 }}
          />
        </FormField>

        <FormField label="显示名称" hint="可选的友好显示名（留空则使用名称）">
          <Input
            placeholder={provider.name}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ borderRadius: 8 }}
          />
        </FormField>

        <FormField label="API 类型" hint="协议/SDK 类型，决定如何调用该供应商">
          <Input
            placeholder="例如 openai / anthropic / ollama"
            value={apiType}
            onChange={(e) => setApiType(e.target.value)}
            style={{ borderRadius: 8 }}
          />
        </FormField>

        <FormField label="Base URL" hint="自定义 API 基础地址（留空使用默认）">
          <Input
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={{ borderRadius: 8 }}
          />
        </FormField>

        <FormField
          label="API Key"
          hint={
            provider.hasCredentials
              ? "已配置（输入新值覆盖；留空保持不变）"
              : "未配置"
          }
        >
          <Input.Password
            placeholder={provider.hasCredentials ? "••••••（已配置）" : "输入 API Key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ borderRadius: 8 }}
          />
        </FormField>
      </div>
    </Modal>
  );
}

// =============================================================================
// Shared card + form field (match General section styling)
// =============================================================================

function Card({
  title, extra, children,
}: {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--gray-0)",
        border: "1px solid var(--gray-150)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: extra ? "1px solid var(--gray-100)" : "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          fontSize: 14,
          fontWeight: 600,
          color: "var(--gray-1000)",
        }}
      >
        <span>{title}</span>
        {extra}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

function FormField({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ color: "var(--gray-700)", fontSize: 12, fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ fontSize: 11, color: "var(--gray-400)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
