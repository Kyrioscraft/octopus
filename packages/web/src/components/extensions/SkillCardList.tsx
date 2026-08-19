import { useNavigate } from "react-router-dom";
import { Button, Spin, Empty, Upload, Tooltip, message as antdMessage } from "antd";
import type { UploadProps } from "antd";
import { BookOpen, Plus, Upload as UploadIcon } from "lucide-react";
import { OctopusClient, type SkillEntry } from "@octopus/tentacle";
import { SettingsCard, SettingsRow, SettingsRows, ListToolbar } from "../shared/SettingsCard.js";

const sdk = new OctopusClient();

interface SkillCardListProps {
  skills: SkillEntry[];
  loading: boolean;
  search: string;
  onReload: () => void;
}

/**
 * Skills tab: settings-style grouped row lists from the unified skill list,
 * split by origin into "已添加" (user-defined), "内置 / 文件" (read-only),
 * and "可安装" (builtin with installable=true). Supports create, upload
 * (.zip/.md), and one-click install of builtin skills.
 */
export function SkillCardList({
  skills,
  loading,
  search,
  onReload,
}: SkillCardListProps) {
  const navigate = useNavigate();

  const q = search.trim().toLowerCase();
  const filtered = skills.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );

  const installable = filtered.filter((s) => s.installable);
  const rest = filtered.filter((s) => !s.installable);
  const owned = rest.filter((s) => s.origin === "user-defined");
  const catalog = rest.filter((s) => s.origin !== "user-defined");

  const installBuiltin = async (name: string) => {
    try {
      await sdk.installBuiltinSkill(name);
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
      try {
        await sdk.importSkill(file as File);
        antdMessage.success("导入完成");
        onReload();
        onSuccess?.({}, new XMLHttpRequest());
      } catch (err: any) {
        antdMessage.error(err?.message ?? "导入失败");
        onError?.(err as Error);
      }
    },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Toolbar */}
      <ListToolbar loading={loading} onReload={onReload}>
        <Tooltip title="创建 Skill">
          <Button
            type="text"
            size="small"
            icon={<Plus />}
            onClick={() => navigate("/extensions/skill/new")}
            style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
          />
        </Tooltip>
        <Tooltip title="上传 Skill">
          <Upload {...uploadProps}>
            <Button
              type="text"
              size="small"
              icon={<UploadIcon />}
              style={{ width: 28, height: 28, borderRadius: 6, color: "var(--gray-600)" }}
            />
          </Upload>
        </Tooltip>
      </ListToolbar>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty description={q ? "无匹配 Skill" : "暂无 Skill"} style={{ marginTop: 60 }} />
      ) : (
        <>
          {owned.length > 0 && (
            <SettingsCard title="已添加">
              <SettingsRows>
                {owned.map((s) => (
                  <SettingsRow
                    key={s.name}
                    icon={<BookOpen />}
                    title={s.name}
                    description={s.description}
                    onClick={() => navigate(`/extensions/skill/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </SettingsRows>
            </SettingsCard>
          )}
          {catalog.length > 0 && (
            <SettingsCard title="内置 / 文件">
              <SettingsRows>
                {catalog.map((s) => (
                  <SettingsRow
                    key={s.name}
                    icon={<BookOpen />}
                    title={s.name}
                    description={s.description}
                    onClick={() => navigate(`/extensions/skill/${encodeURIComponent(s.name)}`)}
                  />
                ))}
              </SettingsRows>
            </SettingsCard>
          )}
          {installable.length > 0 && (
            <SettingsCard title="可安装">
              <SettingsRows>
                {installable.map((s) => (
                  <SettingsRow
                    key={s.name}
                    icon={<BookOpen />}
                    title={s.name}
                    description={s.description}
                  >
                    <Button size="small" onClick={() => installBuiltin(s.name)} style={{ borderRadius: 6 }}>
                      安装
                    </Button>
                  </SettingsRow>
                ))}
              </SettingsRows>
            </SettingsCard>
          )}
        </>
      )}
    </div>
  );
}
