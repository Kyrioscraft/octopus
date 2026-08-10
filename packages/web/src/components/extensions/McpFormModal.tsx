import { useEffect, useState } from "react";
import { Modal, Input, Select, message as antdMessage } from "antd";
import {
  Minus,
  Plus,
} from "lucide-react";
import { OctopusClient, type McpServerEntry, type McpWriteRequest } from "@octopus/tentacle";

const sdk = new OctopusClient();

type Transport = NonNullable<McpWriteRequest["transport"]>;
const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "sse", label: "sse" },
  { value: "http", label: "http" },
  { value: "streamable-http", label: "streamable-http" },
];

interface McpFormModalProps {
  open: boolean;
  initial?: McpServerEntry | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Create / edit a user-defined MCP server. Fields adapt to the chosen
 * transport: stdio → command/args/env; sse/http/streamable-http → url/headers.
 */
export function McpFormModal({ open, initial, onClose, onSaved }: McpFormModalProps) {
  const isEdit = !!initial;
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  // stdio fields
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);
  // http-style fields
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([]);
  const [timeout, setTimeout] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setTransport(initial?.transport ?? "stdio");
    setCommand("");
    setArgs("");
    setEnvPairs([]);
    setUrl("");
    setHeaders([]);
    setTimeout(null);
    if (initial) {
      const cfg = initial.config ?? {};
      setCommand((cfg.command as string) ?? "");
      const a = cfg.args;
      setArgs(Array.isArray(a) ? a.join(" ") : (a as string) ?? "");
      setEnvPairs(objToPairs(cfg.env as Record<string, string> | undefined));
      setUrl((cfg.url as string) ?? "");
      setHeaders(objToPairs(cfg.headers as Record<string, string> | undefined));
      setTimeout((cfg.timeout as number) ?? null);
    }
  }, [open, initial]);

  const isHttp = transport === "sse" || transport === "http" || transport === "streamable-http";

  const buildConfig = (): Record<string, unknown> => {
    if (isHttp) {
      const cfg: Record<string, unknown> = { url: url.trim() };
      const h = pairsToObj(headers);
      if (Object.keys(h).length) cfg.headers = h;
      if (timeout != null && !Number.isNaN(timeout)) cfg.timeout = timeout;
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
    const n = name.trim();
    if (!n) { antdMessage.warning("名称不能为空"); return; }
    if (isHttp && !url.trim()) { antdMessage.warning("URL 不能为空"); return; }
    if (!isHttp && !command.trim()) { antdMessage.warning("command 不能为空"); return; }
    setLoading(true);
    try {
      const body: McpWriteRequest = { name: n, transport, config: buildConfig() };
      if (isEdit && initial) {
        await sdk.updateMcp(initial.name, body);
        antdMessage.success("已更新");
      } else {
        await sdk.createMcp(body);
        antdMessage.success("已创建");
      }
      onSaved();
      onClose();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "保存失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      title={isEdit ? "编辑 MCP" : "添加 MCP"}
      onCancel={onClose}
      onOk={submit}
      okText="保存"
      cancelText="取消"
      confirmLoading={loading}
      width={600}
      destroyOnHidden
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
        <div>
          <div style={labelStyle}>名称</div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
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
                value={timeout ?? ""}
                onChange={(e) => setTimeout(e.target.value === "" ? null : Number(e.target.value))}
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
      </div>
    </Modal>
  );
}

/** Minimal key/value pair editor used for env vars and headers. */
function KeyValueEditor({
  pairs,
  onChange,
  placeholderKey,
  placeholderValue,
}: {
  pairs: { key: string; value: string }[];
  onChange: (p: { key: string; value: string }[]) => void;
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

function objToPairs(obj: Record<string, string> | undefined): { key: string; value: string }[] {
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
}

function pairsToObj(pairs: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const k = p.key.trim();
    if (k) out[k] = p.value;
  }
  return out;
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = { borderRadius: 8 };
const monoFont = "'SFMono-Regular', Consolas, Menlo, monospace";
