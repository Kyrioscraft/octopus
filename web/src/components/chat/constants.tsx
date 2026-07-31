import { EyeOutlined, LockOutlined, ThunderboltOutlined } from "@ant-design/icons";

/**
 * Input toolbar access modes. Aligned with ChatRequest.mode on the server side
 * (tentacle types); only confirm/auto currently alter graph behavior, plan is
 * read-only planning. This table centralizes the per-mode UX (icon, copy,
 * border color, dangerous flag) so the Select, textarea, and warning banner
 * all stay in sync.
 */
export type AccessMode = "plan" | "confirm" | "auto";

export const ACCESS_MODES: Record<AccessMode, {
  icon: React.ReactNode;
  label: string;
  hint: string;
  placeholder: string;
  borderColor: string;
  dangerous: boolean;
}> = {
  plan: {
    icon: <EyeOutlined />,
    label: "计划模式",
    hint: "只规划，不执行变更",
    placeholder: "描述你想要的方案，我只规划不执行…",
    borderColor: "var(--gray-150)",
    dangerous: false,
  },
  confirm: {
    icon: <LockOutlined />,
    label: "变更确认",
    hint: "每步变更都请你确认",
    placeholder: "描述变更，我会逐步请你确认…",
    borderColor: "var(--main-500)",
    dangerous: false,
  },
  auto: {
    icon: <ThunderboltOutlined />,
    label: "自动编辑",
    hint: "全自动执行变更",
    placeholder: "描述任务，我将自动执行…",
    borderColor: "var(--main-color)",
    dangerous: true,
  },
};

/** Cycle order for the Shift+Tab shortcut: plan -> confirm -> auto -> plan. */
export const MODE_ORDER: AccessMode[] = ["plan", "confirm", "auto"];

/** Random greetings shown on the start screen. */
export const GREETINGS = [
  "👋 您好，有什么可以帮您？",
  "👋 你好！有什么想聊的吗？",
  "👋 嘿，有什么我可以帮助你的？",
  "👋 欢迎！今天想讨论什么话题？",
  "👋 你好呀，随时为你服务！",
];
