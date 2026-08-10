import { useState } from "react";
import { Button, Tooltip, Spin, Empty, Popconfirm, message as antdMessage } from "antd";
import {
  Terminal,
  Plus,
  RotateCw,
  Pencil,
  Trash2,
} from "lucide-react";
import { OctopusClient, type SlashCommandEntry } from "@octopus/tentacle";
import { ExtensionCard } from "./ExtensionCard.js";
import { SlashCommandFormModal } from "./SlashCommandFormModal.js";

const sdk = new OctopusClient();

const ORIGIN_LABEL: Record<string, string> = {
  builtin: "内置",
  "user-defined": "自定义",
};

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
 * Slash commands tab: a card grid split into "已添加" (user-defined, editable)
 * and "内置命令" (built-in, read-only) sections.
 */
export function SlashCommandCardList({
  commands,
  loading,
  search,
  onReload,
}: SlashCommandCardListProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SlashCommandEntry | null>(null);

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

  const cardActions = (cmd: SlashCommandEntry) => {
    if (cmd.origin !== "user-defined") return null;
    return (
      <div style={{ display: "flex", gap: 4, marginTop: "auto" }}>
        <Button
          type="text"
          size="small"
          icon={<Pencil />}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(cmd);
          }}
          style={{ color: "var(--gray-500)", borderRadius: 6 }}
        />
        <Popconfirm
          title="确定删除此命令？"
          onConfirm={(e) => {
            e?.stopPropagation();
            handleDelete(cmd);
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
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        <Tooltip title="刷新">
          <Button
            type="text"
            size="small"
            icon={<RotateCw className={loading ? "lucide-spin" : undefined} />}
            onClick={onReload}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
        <Button
          type="primary"
          size="small"
          icon={<Plus />}
          onClick={() => setCreateOpen(true)}
          style={{ borderRadius: 6 }}
        >
          创建命令
        </Button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配命令" : "暂无斜杠命令"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {owned.length > 0 && (
            <Section title={`已添加 (${owned.length})`}>
              <Grid>
                {owned.map((c) => (
                  <div key={c.id} style={{ position: "relative" }}>
                    <ExtensionCard
                      icon={<Terminal />}
                      title={c.displayName}
                      subtitle={`/${c.name}`}
                      description={c.description}
                      tags={[
                        { label: ORIGIN_LABEL[c.origin] ?? c.origin },
                        { label: actionLabel(c), color: c.action === "send" ? "var(--main-color)" : undefined },
                      ]}
                      statusLabel="已启用"
                      statusLevel="success"
                      onClick={() => setEditing(c)}
                    />
                    {/* Edit/delete buttons overlay */}
                    <div style={{ position: "absolute", bottom: 6, right: 6 }}>
                      {cardActions(c)}
                    </div>
                  </div>
                ))}
              </Grid>
            </Section>
          )}
          {builtins.length > 0 && (
            <Section title={`内置命令 (${builtins.length})`}>
              <Grid>
                {builtins.map((c) => (
                  <ExtensionCard
                    key={c.id}
                    icon={<Terminal />}
                    title={c.displayName}
                    subtitle={`/${c.name}`}
                    description={c.description}
                    tags={[
                      { label: ORIGIN_LABEL[c.origin] ?? c.origin },
                      { label: actionLabel(c) },
                    ]}
                    statusLabel="只读"
                    statusLevel="info"
                    disabled
                  />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}

      <SlashCommandFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={onReload}
      />
      <SlashCommandFormModal
        open={!!editing}
        initial={editing}
        onClose={() => setEditing(null)}
        onSaved={onReload}
      />
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
