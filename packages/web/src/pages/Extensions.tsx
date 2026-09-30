import { useState, useCallback, useEffect } from "react";
import { Input } from "antd";
import {
  Search,
} from "lucide-react";
import { PageHeader } from "../components/shared/PageHeader.js";
import {
  OctopusClient,
  type SkillEntry,
  type McpServerEntry,
  type SubagentEntry,
  type SlashCommandEntry,
} from "@octopus/tentacle";
import { SkillCardList } from "../components/extensions/SkillCardList.js";
import { McpCardList } from "../components/extensions/McpCardList.js";
import { SubagentCardList } from "../components/extensions/SubagentCardList.js";
import { SlashCommandCardList } from "../components/extensions/SlashCommandCardList.js";

const sdk = new OctopusClient();

export type ExtensionsTab = "skills" | "mcp" | "subagents" | "commands";

const TAB_TITLES: Record<ExtensionsTab, string> = {
  skills: "技能",
  mcp: "MCP 服务器",
  subagents: "子智能体",
  commands: "斜杠命令",
};

interface ExtensionsPageProps {
  tab: ExtensionsTab;
}

/**
 * Extensions management page (single tab). The tab is driven by the route
 * (rendered per-section); the sidebar (ExtensionsSidebar) handles navigation
 * between sections. This page just renders the active section's toolbar +
 * card grid under a titled header.
 */
export function ExtensionsPage({ tab }: ExtensionsPageProps) {
  const [search, setSearch] = useState("");

  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [mcp, setMcp] = useState<McpServerEntry[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [subagents, setSubagents] = useState<SubagentEntry[]>([]);
  const [subagentsLoading, setSubagentsLoading] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandEntry[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      // Unified list — builtin/file/user-defined in one response, with
      // `installable` marking not-yet-installed builtins.
      setSkills(await sdk.listSkills());
    } catch {
      setSkills([]);
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    try {
      setMcp(await sdk.listMcp(true));
    } catch {
      setMcp([]);
    } finally {
      setMcpLoading(false);
    }
  }, []);

  const loadSubagents = useCallback(async () => {
    setSubagentsLoading(true);
    try {
      setSubagents(await sdk.listSubagents());
    } catch {
      setSubagents([]);
    } finally {
      setSubagentsLoading(false);
    }
  }, []);

  const loadSlashCommands = useCallback(async () => {
    setSlashCommandsLoading(true);
    try {
      setSlashCommands(await sdk.listSlashCommands());
    } catch {
      setSlashCommands([]);
    } finally {
      setSlashCommandsLoading(false);
    }
  }, []);

  // Load the active tab's data when the tab changes.
  useEffect(() => {
    if (tab === "skills") loadSkills();
    if (tab === "mcp") loadMcp();
    if (tab === "subagents") loadSubagents();
    if (tab === "commands") loadSlashCommands();
  }, [tab, loadSkills, loadMcp, loadSubagents, loadSlashCommands]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PageHeader title={TAB_TITLES[tab]} />
      {/* Scrollable content: the search sits under the sticky header. */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px 20px 48px" }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          {/* Search */}
          <Input
            allowClear
            prefix={<Search style={{ color: "var(--text-tertiary)" }} />}
            placeholder={
              tab === "skills" ? "搜索 Skill..." :
              tab === "mcp" ? "搜索 MCP..." :
              tab === "subagents" ? "搜索子智能体..." : "搜索命令..."
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="large"
            style={{ width: "100%", borderRadius: "var(--radius-sm)", marginBottom: 16 }}
          />
          {tab === "skills" ? (
            <SkillCardList
              skills={skills}
              loading={skillsLoading}
              search={search}
              onReload={loadSkills}
            />
          ) : tab === "mcp" ? (
            <McpCardList
              servers={mcp}
              loading={mcpLoading}
              search={search}
              onReload={loadMcp}
            />
          ) : tab === "subagents" ? (
            <SubagentCardList
              subagents={subagents}
              loading={subagentsLoading}
              search={search}
              onReload={loadSubagents}
            />
          ) : (
            <SlashCommandCardList
              commands={slashCommands}
              loading={slashCommandsLoading}
              search={search}
              onReload={loadSlashCommands}
            />
          )}
        </div>
      </div>
    </div>
  );
}
