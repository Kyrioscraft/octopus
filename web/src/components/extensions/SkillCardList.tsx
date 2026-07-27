import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Tooltip, Spin, Empty, Upload, message as antdMessage } from "antd";
import type { UploadProps } from "antd";
import {
  BookOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { OctopusClient, type SkillEntry, type BuiltinSkillSpec } from "@octopus/tentacle";
import { ExtensionCard } from "./ExtensionCard.js";
import { SkillFormModal } from "./SkillFormModal.js";

const sdk = new OctopusClient();

const ORIGIN_LABEL: Record<SkillEntry["origin"], string> = {
  builtin: "内置",
  file: "文件",
  "user-defined": "自定义",
};

interface SkillCardListProps {
  skills: SkillEntry[];
  /** Builtin skills available for installation (status === not_installed). */
  builtinAvailable: BuiltinSkillSpec[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * Skills tab: a card grid split into "已添加", "内置/文件 (read-only)", and
 * "可安装" sections. Supports create, upload (.zip/.md), and one-click
 * install of builtin skills.
 */
export function SkillCardList({
  skills,
  builtinAvailable,
  loading,
  search,
  onReload,
}: SkillCardListProps) {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const q = search.trim().toLowerCase();
  const filtered = skills.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );
  const filteredBuiltin = builtinAvailable.filter(
    (b) => !q || b.name.toLowerCase().includes(q) || (b.description ?? "").toLowerCase().includes(q),
  );

  const owned = filtered.filter((s) => s.origin === "user-defined");
  const catalog = filtered.filter((s) => s.origin !== "user-defined");

  const installBuiltin = async (slug: string) => {
    try {
      await sdk.installBuiltinSkill(slug);
      antdMessage.success("安装成功");
      onReload();
    } catch (err: any) {
      antdMessage.error(err?.message ?? "安装失败");
    }
  };

  // Upload config: accept .zip / .md, validate before upload, custom request.
  const uploadProps: UploadProps = {
    accept: ".zip,.md",
    showUploadList: false,
    beforeUpload: (file) => {
      const lower = (file.name || "").toLowerCase();
      if (!lower.endsWith(".zip") && !lower.endsWith(".md")) {
        antdMessage.error("仅支持上传 .zip 文件或 SKILL.md 文件");
        return Upload.LIST_IGNORE;
      }
      return true;
    },
    customRequest: async (options) => {
      const { file, onSuccess, onError } = options;
      setImporting(true);
      try {
        await sdk.importSkill(file as File);
        antdMessage.success("导入完成");
        onReload();
        onSuccess?.({}, new XMLHttpRequest());
      } catch (err: any) {
        antdMessage.error(err?.message ?? "导入失败");
        onError?.(err as Error);
      } finally {
        setImporting(false);
      }
    },
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
        <Upload {...uploadProps}>
          <Button
            size="small"
            icon={<UploadOutlined />}
            loading={importing}
            style={{ borderRadius: 6 }}
          >
            上传 Skill
          </Button>
        </Upload>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
          style={{ borderRadius: 6 }}
        >
          创建 Skill
        </Button>
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 && filteredBuiltin.length === 0 ? (
        <Empty description={q ? "无匹配 Skill" : "暂无 Skill"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {owned.length > 0 && (
            <Section title={`已添加 (${owned.length})`}>
              <Grid>
                {owned.map((s) => (
                  <ExtensionCard
                    key={s.name}
                    icon={<BookOutlined />}
                    title={s.name}
                    subtitle={s.path}
                    description={s.description}
                    tags={[{ label: ORIGIN_LABEL[s.origin] }]}
                    statusLabel="已启用"
                    statusLevel="success"
                    onClick={() => navigate(`/extensions/skill/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </Grid>
            </Section>
          )}
          {catalog.length > 0 && (
            <Section title={`内置 / 文件 (${catalog.length})`}>
              <Grid>
                {catalog.map((s) => (
                  <ExtensionCard
                    key={s.name}
                    icon={<BookOutlined />}
                    title={s.name}
                    subtitle={s.path}
                    description={s.description}
                    tags={[{ label: ORIGIN_LABEL[s.origin] }]}
                    statusLabel="只读"
                    statusLevel="info"
                    disabled
                    onClick={() => navigate(`/extensions/skill/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </Grid>
            </Section>
          )}
          {filteredBuiltin.length > 0 && (
            <Section title={`可安装 (${filteredBuiltin.length})`}>
              <Grid>
                {filteredBuiltin.map((b) => (
                  <ExtensionCard
                    key={b.slug}
                    icon={<BookOutlined />}
                    title={b.name}
                    description={b.description}
                    tags={[{ label: "内置" }]}
                    disabled
                    actionLabel="安装"
                    onAction={() => installBuiltin(b.slug)}
                  />
                ))}
              </Grid>
            </Section>
          )}
        </>
      )}

      <SkillFormModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={onReload} />
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
