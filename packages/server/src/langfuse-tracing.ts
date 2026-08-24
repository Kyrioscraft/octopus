/**
 * Langfuse tracing —— 每请求注入 CallbackHandler(v5,OpenTelemetry 架构)。
 *
 * v5 SDK(`@langfuse/langchain`)的 span 由启动时注册的
 * `LangfuseSpanProcessor`(见 main.ts)异步导出;CallbackHandler 通过
 * `callbacks` 配置注入到每次 graph stream 调用,因此:
 * - trace 天然按请求划分,可携带 thread_id(session)、userId、agent 等元数据;
 * - 未配置密钥时 `createLangfuseHandler` 返回 undefined,零开销禁用;
 * - HITL resume 是独立的 stream 调用,产生独立 trace,但通过相同的
 *   thread_id(session) 在 Langfuse 中天然关联。
 *
 * 环境变量(优先级):OCTOPUS_LANGFUSE_* > LANGFUSE_*(标准命名)。
 * 密钥与 baseUrl 由 @langfuse/otel 的 SpanProcessor 从环境变量读取。
 */

import { CallbackHandler } from "@langfuse/langchain";
import { getLogger } from "@octopus/core";

const logger = getLogger("server.langfuse");

export interface LangfuseTraceOptions {
  /** LangGraph thread id —— 作为 Langfuse session id,串联同一会话的所有 trace。 */
  threadId: string;
  /** trace 场景标识(chat / chat-resume),写入 metadata。 */
  traceName: string;
  /** 附加到 trace 的元数据(userId、agent 等)。 */
  metadata?: Record<string, unknown>;
}

function envKey(suffix: string): string | undefined {
  const octopus = process.env[`OCTOPUS_LANGFUSE_${suffix}`];
  if (octopus) return octopus;
  return process.env[`LANGFUSE_${suffix}`] || undefined;
}

/** Langfuse tracing 是否已配置(密钥齐全)。 */
export function isLangfuseEnabled(): boolean {
  return !!(envKey("PUBLIC_KEY") && envKey("SECRET_KEY"));
}

let statusLogged = false;

/**
 * 在启动日志中打印 Langfuse tracing 状态(幂等)。
 * 让配置问题(密钥缺失 / .env 未加载)在启动时立刻暴露,
 * 而不是等到第一次对话请求。
 */
export function logLangfuseStatus(): void {
  if (statusLogged) return;
  statusLogged = true;
  if (isLangfuseEnabled()) {
    logger.info("Langfuse tracing 已启用", {
      baseUrl: envKey("BASE_URL") ?? "https://cloud.langfuse.com",
    });
  } else {
    logger.info(
      "Langfuse tracing 未启用 —— 在 packages/server/.env 设置 "
        + "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY(可选 LANGFUSE_BASE_URL)后重启生效。",
    );
  }
}

/**
 * 创建一个请求级 CallbackHandler。未配置密钥时返回 undefined
 * (调用方跳过注入,tracing 完全关闭)。
 *
 * 注意:v5 handler 不再接收密钥参数 —— 上报凭据由 SpanProcessor 从
 * 环境变量读取。但为了尽早暴露配置问题,这里仍检查密钥是否存在。
 */
export function createLangfuseHandler(
  options: LangfuseTraceOptions,
): CallbackHandler | undefined {
  if (!isLangfuseEnabled()) {
    logLangfuseStatus();
    return undefined;
  }
  return new CallbackHandler({
    // thread_id 作为 session id:同一会话(含 HITL resume 的多个 trace)
    // 在 Langfuse 中按 session 聚合。trace 名由根 run 决定,场景标识
    // (chat / chat-resume)放在 traceMetadata 里区分。
    sessionId: options.threadId,
    ...(options.metadata
      ? { traceMetadata: { scene: options.traceName, ...options.metadata } }
      : { traceMetadata: { scene: options.traceName } }),
  });
}

/**
 * v5 SDK 的 span 由全局 LangfuseSpanProcessor 异步批量导出,handler
 * 本身不再持有客户端 —— 无需逐 handler flush。保留此函数作为 no-op
 * 占位,避免调用方(server 路由)逐处修改。
 */
export function flushLangfuseHandler(_handler: CallbackHandler | undefined): void {
  // intentionally no-op (v5: span processor owns export lifecycle)
}
