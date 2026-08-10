/**
 * LangSmith tracing 启动配置。
 *
 * 不手动构造 `LangChainTracer` —— `@langchain/core` 的 callback manager
 * (见 `singletons/tracer.js` + `callbacks/manager.js`)在检测到
 * `LANGSMITH_TRACING=true` 时会自动 `new LangChainTracer()` 并挂载到每次
 * LLM / tool / 子 agent 调用上。手动构造反而受制于 `@langchain/core`
 * exports 不暴露 `./tracers/tracer_langchain` 子路径。
 *
 * 本模块的职责:
 * 1. 把 octopus 命名空间(`OCTOPUS_LANGSMITH_TRACING_*`)的配置同步到
 *    LangChain 实际读取的标准 `LANGSMITH_*` 变量,避免与 deepagents
 *    Sandbox 复用的同名变量混用。
 * 2. 校验必要变量是否齐全,在启动日志里清晰反映 tracing 状态。
 *
 * 环境变量优先级(本模块同步时遵循):
 *   OCTOPUS_LANGSMITH_TRACING_*  >  已有的 LANGSMITH_*  >  默认值
 * Shell 已导出的 LANGSMITH_* 不被覆盖(尊重既有 sandbox 配置)。
 */

import { fromEnvironment, getLogger } from "@octopus/core";

const logger = getLogger("server.langsmith");

let configured = false;

/**
 * 把 octopus 命名空间的 tracing 配置同步到 LangChain 读取的标准变量,
 * 并打印 tracing 状态。仅在 server 启动时调用一次。
 *
 * 幂等:重复调用不会重复同步或重复打印。
 */
export function configureLangSmithTracing(): void {
  if (configured) return;
  configured = true;

  const s = fromEnvironment();

  if (!s.langsmithTracingEnabled) {
    logger.info(
      "LangSmith tracing 已禁用 —— 设置 OCTOPUS_LANGSMITH_TRACING=true 启用。",
    );
    return;
  }

  // 同步 octopus 命名空间 → LangChain 标准变量。
  // 不覆盖 shell 已导出的值,以免影响 deepagents Sandbox 的既有配置。
  if (s.langsmithTracingApiKey && !process.env["LANGSMITH_API_KEY"]) {
    process.env["LANGSMITH_API_KEY"] = s.langsmithTracingApiKey;
  }
  if (s.langsmithTracingEndpoint && !process.env["LANGSMITH_ENDPOINT"]) {
    process.env["LANGSMITH_ENDPOINT"] = s.langsmithTracingEndpoint;
  }
  if (s.langsmithTracingProject && !process.env["LANGSMITH_PROJECT"]) {
    process.env["LANGSMITH_PROJECT"] = s.langsmithTracingProject;
  }
  // LangChain callback manager 检测这个变量决定是否自动注入 tracer。
  if (process.env["LANGSMITH_TRACING"] !== "true") {
    process.env["LANGSMITH_TRACING"] = "true";
  }

  if (!process.env["LANGSMITH_API_KEY"]) {
    logger.warn(
      "LangSmith tracing 已启用但缺少 API key —— "
      + "请设置 OCTOPUS_LANGSMITH_TRACING_API_KEY 或 LANGSMITH_API_KEY。"
      + " tracer 将无法上传数据。",
    );
    return;
  }

  logger.info("LangSmith tracing 已启用", {
    project: process.env["LANGSMITH_PROJECT"] ?? "(default)",
    endpoint: process.env["LANGSMITH_ENDPOINT"] ?? "(default)",
  });
}

/** tracing 是否已启用(供其它模块查询,如 UI 状态展示)。 */
export function isLangSmithTracingEnabled(): boolean {
  return fromEnvironment().langsmithTracingEnabled === true;
}
