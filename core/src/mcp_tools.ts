/**
 * MCP (Model Context Protocol) tools loader.
 *
 * Uses `@modelcontextprotocol/sdk` directly for client connections.
 * Creates LangChain StructuredTool wrappers for MCP tools manually.
 *
 * Equivalent to Python `cortex.mcp_tools`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "./logging.js";
import { getDisabledServers } from "./mcp_disabled.js";

const logger = getLogger("mcp.tools");

// =============================================================================
// Types
// =============================================================================

export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown> | null;
}

export type MCPServerStatus =
  | "ok"
  | "unauthenticated"
  | "awaiting_reconnect"
  | "error"
  | "disabled";

export interface MCPServerInfo {
  name: string;
  transport: string;
  tools: MCPToolInfo[];
  status: MCPServerStatus;
  error?: string;
}

// =============================================================================
// Configuration loading
// =============================================================================

export function loadMcpConfig(configPath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(configPath)) { logger.debug(`MCP config file not found: ${configPath}`); return null; }
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object") { logger.warn(`Invalid MCP config (not an object): ${configPath}`); return null; }
    return config as Record<string, unknown>;
  } catch (err) { logger.warn(`Failed to load MCP config from ${configPath}: ${String(err)}`); return null; }
}

function _validateServerConfig(serverName: string, serverConfig: Record<string, unknown>): void {
  if (!serverConfig || typeof serverConfig !== "object") throw new Error(`Server "${serverName}" config must be an object`);
  const transport = serverConfig["transport"] as string | undefined;
  if (transport === "stdio" || (!transport && serverConfig["command"])) {
    if (!serverConfig["command"]) throw new Error(`Server "${serverName}" (stdio): missing "command"`);
  } else if (transport === "sse" || transport === "http" || transport === "streamable-http") {
    if (!serverConfig["url"]) throw new Error(`Server "${serverName}" (${transport}): missing "url"`);
  } else if (transport) {
    throw new Error(`Server "${serverName}": unsupported transport "${transport}"`);
  }
}

export function mergeMcpConfigs(configs: Array<Record<string, unknown> | null>): Record<string, unknown> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const config of configs) {
    if (!config) continue;
    const servers = config["mcpServers"] as Record<string, Record<string, unknown>> | undefined;
    if (!servers) continue;
    for (const [name, sc] of Object.entries(servers)) merged[name] = { ...(merged[name] ?? {}), ...sc };
  }
  return { mcpServers: merged };
}

export function discoverMcpConfigs(projectRoot?: string): string[] {
  const paths: string[] = [];
  const userPath = join(homedir(), ".deepagents", ".mcp.json");
  if (existsSync(userPath)) paths.push(userPath);
  if (projectRoot) {
    for (const p of [join(projectRoot, ".mcp.json"), join(projectRoot, ".deepagents", ".mcp.json")])
      if (existsSync(p)) paths.push(p);
  }
  return paths;
}

// =============================================================================
// _buildMcpTool — create a LangChain StructuredTool from an MCP tool schema.
// =============================================================================

/**
 * Convert an MCP JSON Schema to a Zod schema.
 * Handles basic types: string, number, boolean, object, array.
 */
function _jsonSchemaToZodSchema(schema: Record<string, unknown> | undefined): any {
  const { z } = require("zod");
  if (!schema || !schema["properties"]) return z.object({});

  const shape: Record<string, any> = {};
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  const required = (schema["required"] as string[]) || [];

  for (const [key, prop] of Object.entries(properties)) {
    let field: any;
    const type = prop["type"] as string;

    switch (type) {
      case "string": {
        let s = z.string();
        if (prop["description"]) s = s.describe(prop["description"] as string);
        field = s;
        break;
      }
      case "number":
      case "integer": {
        let n = z.number();
        if (prop["description"]) n = n.describe(prop["description"] as string);
        field = n;
        break;
      }
      case "boolean": {
        let b = z.boolean();
        if (prop["description"]) b = b.describe(prop["description"] as string);
        field = b;
        break;
      }
      case "array": {
        let a = z.array(z.any());
        if (prop["description"]) a = a.describe(prop["description"] as string);
        field = a;
        break;
      }
      default: {
        let o = z.any();
        if (prop["description"]) o = o.describe(prop["description"] as string);
        field = o;
      }
    }

    if (!required.includes(key)) field = field.optional();
    shape[key] = field;
  }

  return z.object(shape);
}

/**
 * Build a LangChain StructuredTool from an MCP tool definition.
 */
async function _buildMcpTool(toolDef: any, serverName: string, callTool: (name: string, args: Record<string, unknown>) => Promise<any>): Promise<any> {
  const { tool: toolFactory } = await import("@langchain/core/tools");

  const schema = _jsonSchemaToZodSchema(toolDef.inputSchema);

  // Prefix tool name with server name to avoid collisions
  const toolName = `${serverName}__${toolDef.name}`;

  return toolFactory(
    async (input: Record<string, unknown>) => {
      try {
        const result = await callTool(toolDef.name, input);
        // Extract text content from MCP result
        if (result && result.content) {
          const textParts = result.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          return textParts || JSON.stringify(result);
        }
        return JSON.stringify(result);
      } catch (err) {
        return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: toolName,
      description: toolDef.description || `${serverName} tool: ${toolDef.name}`,
      schema,
    },
  );
}

// =============================================================================
// _loadToolsForServer — connect to a single MCP server and load its tools.
// =============================================================================

async function _loadToolsForServer(
  serverName: string,
  serverConfig: Record<string, unknown>,
): Promise<{ tools: any[]; error?: string }> {
  let transport: any;
  let client: any;

  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const transportType = (serverConfig["transport"] as string) || "stdio";

    if (transportType === "stdio") {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({
        command: serverConfig["command"] as string,
        args: serverConfig["args"] as string[],
        env: serverConfig["env"] as Record<string, string> | undefined,
        cwd: serverConfig["cwd"] as string | undefined,
      });
    } else if (transportType === "sse" || transportType === "http" || transportType === "streamable-http") {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(new URL(serverConfig["url"] as string), {
        requestInit: serverConfig["headers"]
          ? { headers: serverConfig["headers"] as Record<string, string> }
          : undefined,
      });
    } else {
      return { tools: [], error: `Unsupported transport: ${transportType}` };
    }

    client = new Client(
      { name: `octopus-mcp-${serverName}`, version: "1.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: any[] = [];

    if (toolsResult && toolsResult.tools) {
      const callTool = async (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });

      for (const toolDef of toolsResult.tools) {
        try {
          const tool = await _buildMcpTool(toolDef, serverName, callTool);
          tools.push(tool);
        } catch (err) {
          logger.warn(`Failed to build tool ${toolDef.name} for server ${serverName}: ${String(err)}`);
        }
      }
    }

    return { tools };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to load tools from MCP server "${serverName}": ${msg}`);
    return { tools: [], error: msg };
  }
}

// =============================================================================
// resolveAndLoadMcpTools — main entry point.
// =============================================================================

export interface McpLoadResult {
  tools: any[];
  serverInfos: MCPServerInfo[];
}

export async function resolveAndLoadMcpTools(options?: {
  explicitConfigPath?: string;
  projectRoot?: string;
  noMcp?: boolean;
  trustProjectMcp?: boolean;
}): Promise<McpLoadResult> {
  if (options?.noMcp) { logger.debug("MCP tools disabled"); return { tools: [], serverInfos: [] }; }

  const configPaths = discoverMcpConfigs(options?.projectRoot);
  if (options?.explicitConfigPath) configPaths.push(options.explicitConfigPath);
  if (configPaths.length === 0) { logger.debug("No MCP config files discovered"); return { tools: [], serverInfos: [] }; }

  const configs: Array<Record<string, unknown>> = [];
  for (const configPath of configPaths) {
    const loaded = loadMcpConfig(configPath);
    if (loaded) configs.push(loaded);
  }
  if (configs.length === 0) return { tools: [], serverInfos: [] };

  const merged = mergeMcpConfigs(configs);
  const servers = merged["mcpServers"] as Record<string, Record<string, unknown>> | undefined;
  if (!servers || Object.keys(servers).length === 0) return { tools: [], serverInfos: [] };

  const disabledNames = getDisabledServers();
  const active: Record<string, Record<string, unknown>> = {};
  const disabledInfos: MCPServerInfo[] = [];

  for (const [name, sc] of Object.entries(servers)) {
    if (disabledNames.has(name)) {
      disabledInfos.push({ name, transport: (sc["transport"] as string) || "stdio", tools: [], status: "disabled", error: "Disabled by user." });
    } else {
      try { _validateServerConfig(name, sc); active[name] = sc; }
      catch (err) { disabledInfos.push({ name, transport: (sc["transport"] as string) || "stdio", tools: [], status: "error", error: String(err) }); }
    }
  }

  if (Object.keys(active).length === 0) return { tools: [], serverInfos: disabledInfos };

  const allTools: any[] = [];
  const serverInfos: MCPServerInfo[] = [];

  for (const [name, sc] of Object.entries(active)) {
    try {
      const { tools: serverTools, error } = await _loadToolsForServer(name, sc);
      serverInfos.push({
        name,
        transport: (sc["transport"] as string) || "stdio",
        tools: serverTools.map((t: any) => ({ name: t.name, description: t.description })),
        status: error ? "error" : "ok",
        error,
      });
      allTools.push(...serverTools);
    } catch (err) {
      serverInfos.push({
        name,
        transport: (sc["transport"] as string) || "stdio",
        tools: [],
        status: "error",
        error: String(err),
      });
    }
  }

  serverInfos.push(...disabledInfos);
  logger.info(`Loaded ${allTools.length} MCP tool(s) from ${serverInfos.filter(s => s.status === "ok").length}/${serverInfos.length} server(s)`);

  return { tools: allTools, serverInfos };
}
