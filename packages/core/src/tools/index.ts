/**
 * Tools public surface — builtin web tools + HITL tool factories.
 *
 * tools/web.ts               — fetch_url / web_search (+ getBuiltinTools)
 * tools/ask_user_question.ts — interactive question tool
 * tools/submit_plan.ts       — plan-mode approval gate tool
 */

export { fetchUrl, webSearch, getBuiltinTools, getBuiltinToolsAsStructuredTools } from "./web.js";
export type { FetchUrlResult, WebSearchResult, WebSearchResultItem } from "./web.js";
