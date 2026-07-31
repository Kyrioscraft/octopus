import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Tooltip, Spin, Empty, message as antdMessage } from "antd";
import { RobotOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { OctopusClient, type SubagentEntry } from "@octopus/tentacle";
import { ExtensionCard } from "./ExtensionCard.js";
import { SubagentFormModal } from "./SubagentFormModal.js";

const sdk = new OctopusClient();

const ORIGIN_LABEL: Record<SubagentEntry["origin"], string> = {
  builtin: "内置",
  file: "文件",
  "user-defined": "自定义",
};

/** Built-in subagents (Explore, general-purpose) are read-only — no toggle/edit. */
const isReadonly = (s: SubagentEntry) => s.origin === "builtin" || s.origin === "file";

interface SubagentCardListProps {
  subagents: SubagentEntry[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * Subagents tab: a card grid split into "已启用" and "已禁用". Disabled cards
 * show an inline "启用" action; enabled cards navigate to detail on click.
 */
export function SubagentCardList({ subagents, loading, search, onReload }: SubagentCardListProps) {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const q = search.trim().toLowerCase();
  const filtered = subagents.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );

  const enabled = filtered.filter((s) => s.enabled);
  const disabled = filtered.filter((s) => !s.enabled);

  const toggle = async (s: SubagentEntry, value: boolean) => {
    try {
      await sdk.setSubagentEnabled(s.name, value);
      antdMessage.success(value ? "已启用" : "已禁用");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        <Tooltip title="刷新">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined spin={loading} />}
            onClick={onReload}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
          style={{ borderRadius: 6 }}
        >
          添加子智能体
        </Button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配子智能体" : "暂无子智能体"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {enabled.length > 0 && (
            <Section title={`已启用 (${enabled.length})`}>
              <Grid>
                {enabled.map((s) => (
                  <ExtensionCard
                    key={s.name}
                    icon={<RobotOutlined />}
                    title={s.name}
                    subtitle={s.model ?? undefined}
                    description={s.description}
                    tags={[
                      {
                        label: ORIGIN_LABEL[s.origin],
                        ...(s.origin === "builtin" ? { color: "var(--main-color)" } : {}),
                      },
                    ]}
                    statusLabel="已启用"
                    statusLevel="success"
                    onClick={() => navigate(`/extensions/subagent/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </Grid>
            </Section>
          )}
          {disabled.length > 0 && (
            <Section title={`已禁用 (${disabled.length})`}>
              <Grid>
                {disabled.map((s) => (
                  <ExtensionCard
                    key={s.name}
                    icon={<RobotOutlined />}
                    title={s.name}
                    subtitle={s.model ?? undefined}
                    description={s.description}
                    tags={[{ label: ORIGIN_LABEL[s.origin] }]}
                    disabled
                    actionLabel="启用"
                    onAction={() => toggle(s, true)}
                    onClick={() => navigate(`/extensions/subagent/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}

      <SubagentFormModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={onReload} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={sectionHeaderStyle}>{title}</div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  marginBottom: 10,
  letterSpacing: "0.02em",
};
