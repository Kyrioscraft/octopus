/**
 * Engine public surface: pure event protocol + LangChain stream adapter.
 */

export type { AgentEvent, AgentRunInput } from "./protocol.js";
export { wrapAgentStream } from "./langchain-adapter.js";
