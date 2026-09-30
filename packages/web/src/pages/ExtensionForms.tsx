import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  Input,
  Select,
  Spin,
  Tooltip,
  message as antdMessage,
} from "antd";
import {
  ArrowLeft,
  Minus,
  Plus,
} from "lucide-react";
import {
  OctopusClient,
  type McpWriteRequest,
} from "@octopus/tentacle";
import { SettingsCard } from "../components/shared/SettingsCard.js";
import {
  topBarStyle,
  iconTileStyle,
  titleStyle,
  subtitleStyle,
  iconBtnStyle,
} from "../components/shared/PageHeader.js";

const sdk = new OctopusClient();

const monoFont = "'SFMono-Regular', Consolas, Menlo, monospace";

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = { borderRadius: 8 };

/**
 * Shared page shell for extension create/edit forms: back button + title in
 * a 45px top bar, then a 900px single-column SettingsCard form with
 * save/cancel actions — matching the general settings page style.
 */
function FormPageShell({
  title,
  onBack,
  onSave,
  saving,
  children,
}: {
  title: string;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Top bar */}
      <div style={topBarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <Tooltip title="返回">
            <Button
              type="text"
              size="small"
              icon={<ArrowLeft />}
              onClick={onBack}
              style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
            />
          </Tooltip>
          <div style={titleStyle}>{title}</div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--bg-canvas)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px" }}>
          <SettingsCard title={title}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {children}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <Button onClick={onBack} style={{ borderRadius: 8 }}>
                  取消
                </Button>
                <Button type="primary" loading={saving} onClick={onSave} style={{ borderRadius: 8 }}>
                  保存
                </Button>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

type Transport = NonNullable<McpWriteRequest["transport"]>;
const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "sse", label: "sse" },
  { value: "http", label: "http" },
  { value: "streamable-http", label: "streamable-http" },
];

/**
 * Create / edit MCP server page (route: /extensions/mcp/new or
 * /extensions/mcp/:name/edit). Fields adapt to the chosen transport:
 * stdio → command/args/env; sse/http/streamable-http → url/headers.
 */
export function McpFormPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const isEdit = !!name;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [serverName, setServerName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  // stdio fields
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envPairs, setEnvPairs] = useState<Pair[]>([]);
  // http-style fields
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<Pair[]>([]);
  const [timeoutSec, setTimeoutSec] = useState<number | null>(null);

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    sdk
      .getMcp(name)
      .then((s) => {
        setServerName(s.name);
        setTransport(s.transport);
        const cfg = s.config ?? {};
        setCommand((cfg.command as string) ?? "");
        const a = cfg.args;
        setArgs(Array.isArray(a) ? a.join(" ") : ((a as string) ?? ""));
        setEnvPairs(objToPairs(cfg.env as Record<string, string> | undefined));
        setUrl((cfg.url as string) ?? "");
        setHeaders(objToPairs(cfg.headers as Record<string, string> | undefined));
        setTimeoutSec((cfg.timeout as number) ?? null);
      })
      .catch((err: any) => antdMessage.error(err?.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [name]);

  const isHttp = transport === "sse" || transport === "http" || transport === "streamable-http";

  const buildConfig = (): Record<string, unknown> => {
    if (isHttp) {
      const cfg: Record<string, unknown> = { url: url.trim() };
      const h = pairsToObj(headers);
      if (Object.keys(h).length) cfg.headers = h;
      if (timeoutSec != null && !Number.isNaN(timeoutSec)) cfg.timeout = timeoutSec;
      return cfg;
    }
    // stdio
    const cfg: Record<string, unknown> = { command: command.trim() };
    const a = args.trim();
    if (a) cfg.args = a.split(/\s+/);
    const e = pairsToObj(envPairs);
    if (Object.keys(e).length) cfg.env = e;
    return cfg;
  };

  const submit = async () => {
    const n = serverName.trim();
    if (!n) { antdMessage.warning("名称不能为空"); return; }
    if (isHttp && !url.trim()) { antdMessage.warning("URL 不能为空"); return; }
    if (!isHttp && !command.trim()) { antdMessage.warning("command 不能为空"); return; }
    setSaving(true);
    try {
      const body: McpWriteRequest = { name: n, transport, config: buildConfig() };
      if (isEdit && name) {
        await sdk.updateMcp(name, body);
        antdMessage.success("已更新");
      } else {
        await sdk.createMcp(body);
        antdMessage.success("已创建");
      }
      navigate(isEdit ? `/extensions/mcp/${encodeURIComponent(n)}` : "/extensions/mcp");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin />
      </div>
    );
  }

  return (
    <FormPageShell
      title={isEdit ? "编辑 MCP" : "添加 MCP"}
      onBack={() => navigate(isEdit ? `/extensions/mcp/${encodeURIComponent(name!)}` : "/extensions/mcp")}
      onSave={submit}
      saving={saving}
    >
      <div>
        <div style={labelStyle}>名称</div>
        <Input
          value={serverName}
          onChange={(e) => setServerName(e.target.value)}
          placeholder="例如：filesystem"
          disabled={isEdit}
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>传输方式</div>
        <Select
          value={transport}
          onChange={(v) => setTransport(v)}
          options={TRANSPORTS}
          style={{ width: "100%" }}
        />
      </div>

      {isHttp ? (
        <>
          <div>
            <div style={labelStyle}>URL</div>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              style={inputStyle}
            />
          </div>
          <div>
            <div style={labelStyle}>Headers（可选）</div>
            <KeyValueEditor pairs={headers} onChange={setHeaders} placeholderKey="Header" placeholderValue="Value" />
          </div>
          <div>
            <div style={labelStyle}>超时（秒，可选）</div>
            <Input
              type="number"
              value={timeoutSec ?? ""}
              onChange={(e) => setTimeoutSec(e.target.value === "" ? null : Number(e.target.value))}
              placeholder="例如：30"
              style={inputStyle}
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <div style={labelStyle}>Command</div>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="例如：npx"
              style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5 }}
            />
          </div>
          <div>
            <div style={labelStyle}>Args（空格分隔）</div>
            <Input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="例如：-y @modelcontextprotocol/server-filesystem /tmp"
              style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5 }}
            />
          </div>
          <div>
            <div style={labelStyle}>环境变量（可选）</div>
            <KeyValueEditor pairs={envPairs} onChange={setEnvPairs} placeholderKey="KEY" placeholderValue="value" />
          </div>
        </>
      )}
    </FormPageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Skill                                                               */
/* ------------------------------------------------------------------ */

/**
 * Create / edit skill page (route: /extensions/skill/new or
 * /extensions/skill/:name/edit). In edit mode the name is read-only
 * (skills are keyed by name); only description + content are editable.
 */
export function SkillFormPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const isEdit = !!name;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    sdk
      .getSkill(name)
      .then((d) => {
        setSkillName(name);
        setDescription(d.description ?? "");
        setContent(d.content ?? "");
      })
      .catch((err: any) => antdMessage.error(err?.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [name]);

  const submit = async () => {
    const n = skillName.trim();
    if (!n) { antdMessage.warning("名称不能为空"); return; }
    setSaving(true);
    try {
      if (isEdit && name) {
        await sdk.updateSkill(name, { description, content });
        antdMessage.success("已更新");
      } else {
        await sdk.createSkill({ name: n, description, content });
        antdMessage.success("已创建");
      }
      navigate(isEdit ? `/extensions/skill/${encodeURIComponent(n)}` : "/extensions/skills");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin />
      </div>
    );
  }

  return (
    <FormPageShell
      title={isEdit ? "编辑 Skill" : "创建 Skill"}
      onBack={() => navigate(isEdit ? `/extensions/skill/${encodeURIComponent(name!)}` : "/extensions/skills")}
      onSave={submit}
      saving={saving}
    >
      <div>
        <div style={labelStyle}>名称</div>
        <Input
          value={skillName}
          onChange={(e) => setSkillName(e.target.value)}
          placeholder="例如：code-reviewer"
          disabled={isEdit}
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>描述</div>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话描述这个 Skill 的用途"
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>内容（SKILL.md 正文）</div>
        <Input.TextArea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          autoSize={{ minRows: 10, maxRows: 24 }}
          placeholder={"支持 Markdown。frontmatter（name/description）由系统自动生成。"}
          style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5 }}
        />
      </div>
    </FormPageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Subagent                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create / edit subagent page (route: /extensions/subagent/new or
 * /extensions/subagent/:name/edit). Five fields: name (read-only in
 * edit), description, systemPrompt, tools, model.
 */
export function SubagentFormPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const isEdit = !!name;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [model, setModel] = useState("");

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    sdk
      .getSubagent(name)
      .then((s) => {
        setAgentName(s.name);
        setDescription(s.description ?? "");
        setSystemPrompt(s.systemPrompt ?? "");
        setTools(s.tools ?? []);
        setModel(s.model ?? "");
      })
      .catch((err: any) => antdMessage.error(err?.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [name]);

  const submit = async () => {
    const n = agentName.trim();
    if (!n) { antdMessage.warning("名称不能为空"); return; }
    if (!systemPrompt.trim()) { antdMessage.warning("系统提示词不能为空"); return; }
    setSaving(true);
    try {
      // model: empty string → null (clears override); undefined when not provided.
      const modelValue = model.trim() === "" ? null : model.trim();
      if (isEdit && name) {
        await sdk.updateSubagent(name, {
          description,
          systemPrompt,
          tools,
          model: modelValue,
        });
        antdMessage.success("已更新");
      } else {
        await sdk.createSubagent({
          name: n,
          description,
          systemPrompt,
          tools,
          model: modelValue,
        });
        antdMessage.success("已创建");
      }
      navigate(isEdit ? `/extensions/subagent/${encodeURIComponent(n)}` : "/extensions/subagents");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin />
      </div>
    );
  }

  return (
    <FormPageShell
      title={isEdit ? "编辑子智能体" : "创建子智能体"}
      onBack={() => navigate(isEdit ? `/extensions/subagent/${encodeURIComponent(name!)}` : "/extensions/subagents")}
      onSave={submit}
      saving={saving}
    >
      <div>
        <div style={labelStyle}>名称</div>
        <Input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="例如：research-agent（唯一标识）"
          disabled={isEdit}
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>描述</div>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="主智能体据此决定何时委派任务给此子智能体"
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>系统提示词</div>
        <Input.TextArea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          autoSize={{ minRows: 6, maxRows: 20 }}
          placeholder="子智能体的行为指令..."
          style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5 }}
        />
      </div>
      <div>
        <div style={labelStyle}>工具（可选）</div>
        <Select
          mode="tags"
          value={tools}
          onChange={setTools}
          placeholder="输入工具名称后回车（白名单，留空则继承全部）"
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <div style={labelStyle}>模型覆盖（可选）</div>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="例如：anthropic:claude-sonnet-4-6（留空继承默认）"
          style={inputStyle}
        />
      </div>
    </FormPageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Slash command                                                       */
/* ------------------------------------------------------------------ */

const CATEGORY_OPTIONS = [
  { label: "写作", value: "writing" },
  { label: "编程", value: "coding" },
  { label: "工具", value: "utility" },
];

const ACTION_OPTIONS = [
  { label: "插入模板", value: "insert" },
  { label: "插入并发送", value: "send" },
];

/**
 * Create / edit slash command page (route: /extensions/command/new or
 * /extensions/command/:id/edit — commands are keyed by id, not name).
 */
export function SlashCommandFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [action, setAction] = useState<"insert" | "send">("insert");
  const [category, setCategory] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    sdk
      .getSlashCommand(id)
      .then((c) => {
        setName(c.name ?? "");
        setDisplayName(c.displayName ?? "");
        setDescription(c.description ?? "");
        setPromptTemplate(c.promptTemplate ?? "");
        setAction((c.action as "insert" | "send") ?? "insert");
        setCategory(c.category ?? undefined);
      })
      .catch((err: any) => antdMessage.error(err?.message ?? "加载失败"))
      .finally(() => setLoading(false));
  }, [id]);

  const submit = async () => {
    const n = name.trim();
    if (!n) { antdMessage.warning("命令名不能为空"); return; }
    if (!displayName.trim()) { antdMessage.warning("显示名不能为空"); return; }
    if (!promptTemplate.trim()) { antdMessage.warning("提示模板不能为空"); return; }
    setSaving(true);
    try {
      const body = {
        name: n,
        displayName: displayName.trim(),
        description: description.trim(),
        promptTemplate: promptTemplate.trim(),
        action,
        category: category || null,
      };
      if (isEdit && id) {
        await sdk.updateSlashCommand(id, body);
        antdMessage.success("已更新");
      } else {
        await sdk.createSlashCommand(body);
        antdMessage.success("已创建");
      }
      navigate("/extensions/commands");
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin />
      </div>
    );
  }

  return (
    <FormPageShell
      title={isEdit ? "编辑斜杠命令" : "创建斜杠命令"}
      onBack={() => navigate("/extensions/commands")}
      onSave={submit}
      saving={saving}
    >
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>命令名（英文）</div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：translate"
            disabled={isEdit}
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>显示名</div>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例如：翻译"
            style={inputStyle}
          />
        </div>
      </div>
      <div>
        <div style={labelStyle}>描述</div>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="在命令菜单中显示的简短描述"
          style={inputStyle}
        />
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>行为</div>
          <Select
            value={action}
            onChange={(v) => setAction(v)}
            options={ACTION_OPTIONS}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>分类</div>
          <Select
            value={category}
            onChange={(v) => setCategory(v)}
            placeholder="选择分类"
            allowClear
            options={CATEGORY_OPTIONS}
            style={{ width: "100%" }}
          />
        </div>
      </div>
      <div>
        <div style={labelStyle}>
          提示模板{" "}
          <span style={{ fontWeight: 400, color: "var(--gray-400)", fontSize: 11 }}>
            （使用 {"{input}"} 作为用户输入的占位符）
          </span>
        </div>
        <Input.TextArea
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 12 }}
          placeholder={"请将以下文本翻译成中文：\n{input}"}
          style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5 }}
        />
      </div>
    </FormPageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

interface Pair {
  key: string;
  value: string;
}

/** Minimal key/value pair editor used for env vars and headers. */
function KeyValueEditor({
  pairs,
  onChange,
  placeholderKey,
  placeholderValue,
}: {
  pairs: Pair[];
  onChange: (p: Pair[]) => void;
  placeholderKey: string;
  placeholderValue: string;
}) {
  const update = (i: number, field: "key" | "value", v: string) => {
    const next = pairs.map((p, idx) => (idx === i ? { ...p, [field]: v } : p));
    onChange(next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {pairs.map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <Input
            value={p.key}
            onChange={(e) => update(i, "key", e.target.value)}
            placeholder={placeholderKey}
            style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5 }}
          />
          <Input
            value={p.value}
            onChange={(e) => update(i, "value", e.target.value)}
            placeholder={placeholderValue}
            style={{ ...inputStyle, fontFamily: monoFont, fontSize: 12.5, flex: 1.4 }}
          />
          <Minus
            onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
            style={{ alignSelf: "center", color: "var(--gray-500)", cursor: "pointer", padding: "0 6px" }}
          />
        </div>
      ))}
      <div
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          alignSelf: "flex-start",
          cursor: "pointer",
          fontSize: 12,
          color: "var(--main-color)",
          padding: "2px 0",
        }}
      >
        <Plus /> 添加一项
      </div>
    </div>
  );
}

function objToPairs(obj: Record<string, string> | undefined): Pair[] {
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
}

function pairsToObj(pairs: Pair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const k = p.key.trim();
    if (k) out[k] = p.value;
  }
  return out;
}
