import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Tooltip, Spin, Modal, message as antdMessage } from "antd";
import {
  ArrowLeft,
  BookOpen,
  Pencil,
  Trash2,
} from "lucide-react";
import { OctopusClient, type SkillDetail } from "@octopus/tentacle";
import { Markdown } from "../components/widgets/Markdown.js";
import { SkillFormModal } from "../components/extensions/SkillFormModal.js";

const sdk = new OctopusClient();

/**
 * Skill detail page. Shows the SKILL.md content (rendered markdown) with
 * edit/delete actions for user-defined skills; file/builtin are read-only.
 */
export function SkillDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    try {
      setDetail(await sdk.getSkill(name));
    } catch (err: any) {
      antdMessage.error(err?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => { load(); }, [load]);

  const editable = detail?.editable ?? false;

  const onDelete = () => {
    if (!name) return;
    Modal.confirm({
      title: "删除 Skill",
      content: `确定删除「${name}」吗？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await sdk.deleteSkill(name);
          antdMessage.success("已删除");
          navigate("/extensions/skills");
        } catch (err: any) {
          antdMessage.error(err?.message ?? "删除失败");
        }
      },
    });
  };

  const back = () => navigate("/extensions/skills");

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
              onClick={back}
              style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
            />
          </Tooltip>
          <div style={iconTileStyle}>
            <BookOpen />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={titleStyle}>{name}</div>
            <div style={subtitleStyle}>
              {detail ? `来源：${detail.origin}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {editable && (
            <>
              <Tooltip title="编辑">
                <Button
                  type="text"
                  size="small"
                  icon={<Pencil />}
                  onClick={() => setEditOpen(true)}
                  style={iconBtnStyle}
                />
              </Tooltip>
              <Tooltip title="删除">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<Trash2 />}
                  onClick={onDelete}
                  style={iconBtnStyle}
                />
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", background: "var(--gray-10)" }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
            <Spin />
          </div>
        ) : detail ? (
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>
            {detail.description && (
              <div style={descStyle}>{detail.description}</div>
            )}
            <div style={panelStyle}>
              <div style={panelHeaderStyle}>SKILL.md</div>
              <div style={{ padding: "0 4px" }}>
                <Markdown content={detail.content || "（无内容）"} />
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: 80, textAlign: "center", color: "var(--gray-500)" }}>
            Skill 不存在
          </div>
        )}
      </div>

      {detail && (
        <SkillFormModal
          open={editOpen}
          initial={{ name: name!, description: detail.description, origin: detail.origin, editable: detail.editable }}
          onClose={() => setEditOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

const topBarStyle: React.CSSProperties = {
  height: 45,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 16px",
  borderBottom: "1px solid var(--gray-150)",
  flexShrink: 0,
  background: "var(--gray-0)",
};

const iconTileStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: "var(--main-20)",
  color: "var(--main-color)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 17,
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--gray-1000)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--gray-500)",
  marginTop: 2,
};

const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  color: "var(--gray-600)",
};

const descStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--gray-700)",
  lineHeight: 1.6,
  marginBottom: 16,
  padding: "12px 16px",
  background: "var(--gray-0)",
  borderRadius: 10,
  border: "1px solid var(--gray-150)",
};

const panelStyle: React.CSSProperties = {
  background: "var(--gray-0)",
  borderRadius: 10,
  border: "1px solid var(--gray-150)",
  overflow: "hidden",
};

const panelHeaderStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--gray-700)",
  padding: "12px 16px",
  borderBottom: "1px solid var(--gray-100)",
  background: "var(--gray-25)",
  fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
};
