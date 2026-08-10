/**
 * Built-in tools for the agent engine.
 *
 * Equivalent to Python `cortex.tools`.
 *
 * Two callable functions (`fetchUrl`, `webSearch`) that the agent can invoke.
 * Exports both plain async functions (for direct use) and LangChain
 * StructuredTool wrappers (for passing to `createDeepAgent`).
 */

import { resolveEnvVar } from "./model_config.js";
import { z } from "zod";

// =============================================================================
// Types
// =============================================================================

export interface FetchUrlResult {
  url?: string;
  markdown_content?: string;
  status_code?: number;
  content_length?: number;
  error?: string;
  category?: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface WebSearchResult {
  results?: WebSearchResultItem[];
  query: string;
  error?: string;
}

// =============================================================================
// SSRF Protection — equivalent to Python `_validate_url` + `_is_blocked_ip`.
// =============================================================================

import { isIP } from "node:net";

/** IPv4 private / special ranges that should be blocked. */
const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",       // Current network
  "10.0.0.0/8",      // Private (RFC 1918)
  "100.64.0.0/10",   // Carrier-grade NAT (RFC 6598)
  "127.0.0.0/8",     // Loopback
  "169.254.0.0/16",  // Link-local (includes cloud IMDS at 169.254.169.254)
  "172.16.0.0/12",   // Private (RFC 1918)
  "192.0.0.0/24",    // IETF protocol assignments
  "192.0.2.0/24",    // TEST-NET-1
  "192.168.0.0/16",  // Private (RFC 1918)
  "198.18.0.0/15",   // Benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24",  // TEST-NET-3
  "224.0.0.0/4",     // Multicast
  "240.0.0.0/4",     // Reserved
];

/**
 * Check if an IPv4 address falls within any blocked CIDR range.
 *
 * Uses simple bitmask math — no external dependencies.
 */
function _isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const ipNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;

  for (const cidr of BLOCKED_IPV4_CIDRS) {
    const [rangeIp, bits] = cidr.split("/");
    const rangeParts = rangeIp.split(".").map(Number);
    const rangeNum = ((rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3]) >>> 0;
    const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
    if ((ipNum & mask) === (rangeNum & mask)) return true;
  }
  return false;
}

/**
 * Validate a URL against SSRF attacks.
 *
 * Checks scheme (http/https only) and resolves the hostname to verify it
 * does not point to a private/internal address.
 *
 * Equivalent to Python `_validate_url()`.
 */
async function _validateUrl(url: string): Promise<void> {
  const parsed = new URL(url);

  // Scheme check
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme not allowed: ${parsed.protocol} (must be http or https)`);
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error("URL is missing a hostname");
  }

  // DNS resolution with SSRF guard
  const { resolve4, resolve6 } = await import("node:dns/promises");

  let addresses: string[] = [];
  try {
    const [v4, v6] = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);
    if (v4.status === "fulfilled") addresses.push(...v4.value);
    if (v6.status === "fulfilled") addresses.push(...v6.value);
  } catch {
    throw new Error(`Could not resolve hostname '${hostname}'`);
  }

  if (addresses.length === 0) {
    throw new Error(`Hostname '${hostname}' resolved to no addresses`);
  }

  for (const addr of addresses) {
    if (isIP(addr) === 4) {
      if (_isBlockedIPv4(addr)) {
        throw new Error(
          `URL hostname '${hostname}' resolves to blocked address ${addr} ` +
          "(private, loopback, link-local, reserved, or non-global range)",
        );
      }
    } else if (isIP(addr) === 6) {
      // Block IPv6 loopback, link-local, unique local
      if (
        addr === "::1" ||
        addr.startsWith("fe80:") ||
        addr.startsWith("fc") ||
        addr.startsWith("fd")
      ) {
        throw new Error(
          `URL hostname '${hostname}' resolves to blocked IPv6 address ${addr}`,
        );
      }
    }
  }
}

// =============================================================================
// fetchUrl — equivalent to Python `fetch_url()`.
// =============================================================================

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
const MAX_FETCH_REDIRECTS = 5;
const FETCH_USER_AGENT = "Mozilla/5.0 (compatible; DeepAgents/1.0)";

/**
 * Fetch content from a URL and convert HTML to markdown.
 *
 * Includes SSRF protection: validates URL scheme, resolves DNS and blocks
 * private/loopback/link-local addresses, follows up to 5 redirects (re-validating
 * each hop).
 *
 * Equivalent to Python `fetch_url()`.
 */
export async function fetchUrl(
  url: string,
  timeout: number = 30,
): Promise<FetchUrlResult> {
  try {
    const TurndownService = (await import("turndown")).default;
    const turndown = new TurndownService({ headingStyle: "atx" });

    // Fetch with redirect following + SSRF validation per hop
    let currentUrl = url;
    let response: Response;

    for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
      await _validateUrl(currentUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      try {
        response = await fetch(currentUrl, {
          method: "GET",
          headers: { "User-Agent": FETCH_USER_AGENT },
          redirect: "manual",  // We handle redirects ourselves for SSRF re-validation
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        if (!location) {
          return {
            error: `Redirect response (status ${response.status}) is missing a Location header`,
            url: currentUrl,
            category: "validation",
          };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        return {
          error: `HTTP ${response.status}: ${response.statusText}`,
          url: response.url,
          category: "network",
        };
      }

      const html = await response.text();
      const markdown = turndown.turndown(html);

      return {
        url: response.url,
        markdown_content: markdown,
        status_code: response.status,
        content_length: markdown.length,
      };
    }

    return {
      error: `Exceeded ${MAX_FETCH_REDIRECTS} redirects starting from ${url}`,
      url,
      category: "redirects",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Fetch URL error: ${message}`, url, category: "network" };
  }
}

// =============================================================================
// webSearch — equivalent to Python `web_search()`.
// =============================================================================

let _tavilyClient: unknown = undefined;

/**
 * Search the web using the Tavily API.
 *
 * Lazily initializes a Tavily client singleton from the TAVILY_API_KEY env var
 * (resolved via `resolveEnvVar` for DEEPAGENTS_CODE_ prefix support).
 *
 * Equivalent to Python `web_search()`.
 */
export async function webSearch(
  query: string,
  maxResults: number = 5,
  topic: "general" | "news" | "finance" = "general",
  includeRawContent: boolean = false,
): Promise<WebSearchResult> {
  // Lazy-init Tavily client
  if (_tavilyClient === undefined) {
    const apiKey = resolveEnvVar("TAVILY_API_KEY");
    if (apiKey) {
      // Use fetch to Tavily REST API directly (avoids native SDK dependency)
      _tavilyClient = apiKey;
    } else {
      _tavilyClient = null;
    }
  }

  if (_tavilyClient === null) {
    return {
      error: "Tavily API key not configured. Please set TAVILY_API_KEY environment variable.",
      query,
    };
  }

  const apiKey = _tavilyClient as string;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        topic,
        include_raw_content: includeRawContent,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      return { error: `Web search error: HTTP ${res.status} - ${errText}`, query };
    }

    const data = (await res.json()) as { results?: WebSearchResultItem[] };
    return { results: data.results ?? [], query };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Web search error: ${message}`, query };
  }
}

// =============================================================================
// StructuredTool wrappers — for passing to `createDeepAgent({ tools: [...] })`.
// Equivalent to Python's deepagents Tool wrapping convention.
// =============================================================================

/** Zod schema for `fetchUrl` parameters. */
const FetchUrlSchema = z.object({
  url: z.string().describe("The URL to fetch (must be a valid HTTP/HTTPS URL)"),
  timeout: z.number().optional().default(30).describe("Request timeout in seconds"),
});

/** LangChain StructuredTool wrapper for fetchUrl. */
export async function _fetchUrlWrapped(input: { url: string; timeout?: number }): Promise<string> {
  const result = await fetchUrl(input.url, input.timeout);
  return JSON.stringify(result);
}

/** Zod schema for `webSearch` parameters. */
const WebSearchSchema = z.object({
  query: z.string().describe("The search query (be specific and detailed)"),
  max_results: z.number().optional().default(5).describe("Number of results to return"),
  topic: z.enum(["general", "news", "finance"]).optional().default("general").describe("Search topic type"),
  include_raw_content: z.boolean().optional().default(false).describe("Include full page content"),
});

/** LangChain StructuredTool wrapper for webSearch. */
export async function _webSearchWrapped(input: {
  query: string;
  max_results?: number;
  topic?: "general" | "news" | "finance";
  include_raw_content?: boolean;
}): Promise<string> {
  const result = await webSearch(input.query, input.max_results, input.topic, input.include_raw_content);
  return JSON.stringify(result);
}

/** Tool descriptor for `tool()` wrapping. */
interface ToolDescriptor {
  schema: z.ZodType<any>;
  func: (...args: any[]) => Promise<any>;
  name: string;
  description: string;
}

/** All built-in tool descriptors (for `tool()` wrapping). */
const BUILTIN_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    schema: FetchUrlSchema,
    func: _fetchUrlWrapped as any,
    name: "fetch_url",
    description:
      "Fetch content from a URL and convert HTML to markdown. " +
      "After receiving results, you MUST synthesize the information into a natural, " +
      "helpful response for the user. NEVER show the raw JSON to the user.",
  },
  {
    schema: WebSearchSchema,
    func: _webSearchWrapped as any,
    name: "web_search",
    description:
      "Search the web using Tavily for current information and documentation. " +
      "After receiving results, you MUST synthesize the information into a natural, " +
      "helpful response for the user. Cite sources by mentioning page titles or URLs.",
  },
];

/**
 * Return built-in tools as LangChain StructuredTool instances.
 *
 * Uses the `tool()` factory from `@langchain/core/tools` to create proper
 * StructuredTool instances with Zod schemas, suitable for passing to
 * `createDeepAgent({ tools: [...] })`.
 *
 * Equivalent to Python `get_builtin_tools()` wrapped by deepagents' Tool convention.
 */
export async function getBuiltinToolsAsStructuredTools(): Promise<any[]> {
  const { tool: toolFactory } = await import("@langchain/core/tools");
  return BUILTIN_TOOL_DESCRIPTORS.map((desc) =>
    toolFactory(desc.func, {
      name: desc.name,
      description: desc.description,
      schema: desc.schema,
    }),
  );
}

// =============================================================================
// getBuiltinTools — plain callable descriptors (for backward compat).
// Equivalent to Python `get_builtin_tools()`.
// =============================================================================

/**
 * Return the always-on built-in tools for the agent graph.
 *
 * These are plain callables — the deepagents SDK wraps them as tools.
 * The SDK already wires up shell/filesystem/todo tools via middleware,
 * so this list only includes URL-fetch + web-search extras.
 *
 * Equivalent to Python `get_builtin_tools()`.
 */
export function getBuiltinTools(): Array<{
  name: string;
  func: (...args: any[]) => Promise<any>;
  description: string;
}> {
  return [
    {
      name: "fetch_url",
      func: _fetchUrlWrapped,
      description: BUILTIN_TOOL_DESCRIPTORS[0].description,
    },
    {
      name: "web_search",
      func: _webSearchWrapped,
      description: BUILTIN_TOOL_DESCRIPTORS[1].description,
    },
  ];
}
