import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Spin, Empty, Switch, Select, Tag, Tooltip, message as antdMessage } from "antd";
import { Bot, Plus } from "lucide-react";
import { OctopusClient, type SubagentEntry } from "@octopus/tentacle";
import { SettingsCard, SettingsRow, SettingsRows, ListToolbar } from "../shared/SettingsCard.js";

const sdk = new OctopusClient();

interface SubagentCardListProps {
  subagents: SubagentEntry[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * Subagents tab: settings-style grouped row lists split into "内置 / 文件"
 * (read-only) and "自定义" (user-defined). Custom rows carry an inline enable
 * Switch; builtin rows carry an inline model Select (same source/format as
 * the chat input's model picker) so the model can be changed without opening
 * the detail page.
 */
export function SubagentCardList({ subagents, loading, search, onReload }: SubagentCardListProps) {
  const navigate = useNavigate();
  // Grouped model options (same shape/format as the chat input's model Select).
  const [modelOptions, setModelOptions] = useState<
    Array<{ label: string; options: Array<{ label: string; value: string }> }>
  >([]);

  useEffect(() => {
    // Lazy-load once (same source as the chat input).
    sdk
      .listModelSettings()
      .then((res) => {
        setModelOptions(
          res.providers
            .filter((p) => p.enabled && p.models.length > 0)
            .map((p) => ({
              label: p.displayName || p.name,
              options: p.models.map((m: string) => ({
                label: `${p.name}:${m}`,
                value: `${p.name}:${m}`,
              })),
            })),
        );
      })
      .catch(() => {
        // Non-fatal — the Select falls back to "默认模型" only.
      });
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = subagents.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );

  const builtin = filtered.filter((s) => s.origin !== "user-defined");
  const custom = filtered.filter((s) => s.origin === "user-defined");

  const toggle = async (s: SubagentEntry, value: boolean) => {
    try {
      await sdk.setSubagentEnabled(s.name, value);
      antdMessage.success(value ? "已启用" : "已禁用");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    }
  };

  const changeModel = async (s: SubagentEntry, value: string) => {
    const model = value === "__default__" ? null : value;
    try {
      await sdk.updateSubagent(s.name, { model });
      antdMessage.success(model ? "模型已更新" : "已恢复默认模型");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "操作失败");
    }
  };

  const row = (s: SubagentEntry) => (
    <SettingsRow
      key={s.name}
      icon={<Bot />}
      title={s.name}
      meta={
        s.origin === "builtin" ? (
          <Tag style={{ margin: 0, borderRadius: 4, fontSize: 11, lineHeight: "18px", padding: "0 5px" }}>
            内置 · 始终启用
          </Tag>
        ) : s.origin === "file" ? (
          <Tag style={{ margin: 0, borderRadius: 4, fontSize: 11, lineHeight: "18px", padding: "0 5px" }}>
            文件 · 只读
          </Tag>
        ) : undefined
      }
      description={
        <span
          title={s.description}
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            lineHeight: 1.5,
          }}
        >
          {s.description || "（无描述）"}
        </span>
      }
      onClick={() => navigate(`/extensions/subagent/${encodeURIComponent(s.name)}`)}
    >
      {s.origin === "user-defined" ? (
        <Switch
          size="small"
          checked={s.enabled}
          onClick={(_, e) => e.stopPropagation()}
          onChange={(v) => toggle(s, v)}
        />
      ) : s.origin === "builtin" ? (
        // Built-ins are always enabled (no toggle) — the model is picked
        // inline, without entering the detail page.
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ flexShrink: 0, fontSize: 12, color: "var(--gray-600)" }}
        >
          <Select
            size="small"
            variant="borderless"
            value={s.model ?? "__default__"}
            onChange={(v) => changeModel(s, v)}
            style={{ width: "auto", minWidth: 0, fontSize: 12, color: "var(--gray-600)" }}
            popupMatchSelectWidth={false}
            options={[
              { label: "默认模型", value: "__default__" },
              ...modelOptions,
            ]}
          />
        </div>
      ) : null}
    </SettingsRow>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Toolbar */}
      <ListToolbar loading={loading} onReload={onReload}>
        <Tooltip title="添加子智能体">
          <Button
            type="text"
            size="small"
            icon={<Plus />}
            onClick={() => navigate("/extensions/subagent/new")}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
      </ListToolbar>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配子智能体" : "暂无子智能体"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {builtin.length > 0 && (
            <SettingsCard title="内置 / 文件">
              <SettingsRows>{builtin.map(row)}</SettingsRows>
            </SettingsCard>
          )}
          {custom.length > 0 && (
            <SettingsCard title="自定义">
              <SettingsRows>{custom.map(row)}</SettingsRows>
            </SettingsCard>
          )}
        </>
      )}
    </div>
  );
}
