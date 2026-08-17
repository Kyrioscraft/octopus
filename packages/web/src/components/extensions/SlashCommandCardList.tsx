import { useNavigate } from "react-router-dom";
import { Button, Spin, Empty, Popconfirm, Tag, Tooltip, message as antdMessage } from "antd";
import { Terminal, Pencil, Trash2, Plus } from "lucide-react";
import { OctopusClient, type SlashCommandEntry } from "@octopus/tentacle";
import { SettingsCard, SettingsRow, SettingsRows, ListToolbar } from "../shared/SettingsCard.js";

const sdk = new OctopusClient();

const ACTION_LABEL: Record<string, string> = {
  insert: "插入",
  send: "发送",
};

function actionLabel(cmd: SlashCommandEntry): string {
  if (cmd.kind === "system") return "系统";
  return ACTION_LABEL[cmd.action ?? "insert"] ?? "插入";
}

interface SlashCommandCardListProps {
  commands: SlashCommandEntry[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * Slash commands tab: settings-style grouped row lists split into "已添加"
 * (user-defined, editable) and "内置命令" (built-in, read-only).
 */
export function SlashCommandCardList({
  commands,
  loading,
  search,
  onReload,
}: SlashCommandCardListProps) {
  const navigate = useNavigate();

  const q = search.trim().toLowerCase();
  const filtered = commands.filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.displayName.toLowerCase().includes(q) ||
      (c.description ?? "").toLowerCase().includes(q),
  );

  const owned = filtered.filter((c) => c.origin === "user-defined");
  const builtins = filtered.filter((c) => c.origin === "builtin");

  const handleDelete = async (cmd: SlashCommandEntry) => {
    try {
      await sdk.deleteSlashCommand(cmd.id);
      antdMessage.success("已删除");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "删除失败");
    }
  };

  const tagStyle: React.CSSProperties = {
    margin: 0,
    borderRadius: 999,
    fontSize: 11,
    padding: "0 8px",
    lineHeight: "20px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Toolbar */}
      <ListToolbar loading={loading} onReload={onReload}>
        <Tooltip title="创建命令">
          <Button
            type="text"
            size="small"
            icon={<Plus />}
            onClick={() => navigate("/extensions/command/new")}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
      </ListToolbar>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配命令" : "暂无斜杠命令"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {owned.length > 0 && (
            <SettingsCard title="已添加">
              <SettingsRows>
                {owned.map((c) => (
                  <SettingsRow
                    key={c.id}
                    icon={<Terminal />}
                    title={c.displayName}
                    description={c.description}
                    meta={
                      <Tag
                        style={{
                          ...tagStyle,
                          ...(c.action === "send"
                            ? { color: "var(--main-color)", borderColor: "var(--main-color)", background: "transparent" }
                            : {}),
                        }}
                      >
                        {actionLabel(c)}
                      </Tag>
                    }
                    onClick={() => navigate(`/extensions/command/${encodeURIComponent(c.id)}/edit`)}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<Pencil />}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/extensions/command/${encodeURIComponent(c.id)}/edit`);
                      }}
                      style={{ color: "var(--gray-500)", borderRadius: 6 }}
                    />
                    <Popconfirm
                      title="确定删除此命令？"
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        handleDelete(c);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<Trash2 />}
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: "var(--gray-500)", borderRadius: 6 }}
                      />
                    </Popconfirm>
                  </SettingsRow>
                ))}
              </SettingsRows>
            </SettingsCard>
          )}
          {builtins.length > 0 && (
            <SettingsCard title="内置命令">
              <SettingsRows>
                {builtins.map((c) => (
                  <SettingsRow
                    key={c.id}
                    icon={<Terminal />}
                    title={c.displayName}
                    description={c.description}
                    meta={<Tag style={tagStyle}>{actionLabel(c)}</Tag>}
                  />
                ))}
              </SettingsRows>
            </SettingsCard>
          )}
        </>
      )}
    </div>
  );
}
