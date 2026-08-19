# 内置图表生成 MCP（@antv/mcp-server-chart）

## 1. 新建项目级 `D:\workstation\webworks\octopus\.mcp.json`
- `discoverMcpConfigs`（`core/src/mcp_tools.ts:80-90`）会自动发现项目根 `.mcp.json`，无需改任何 TS 代码，web/TUI 界面会自动将其显示为「内置 / 文件」组（只读）。
- 内容：
```json
{
  "mcpServers": {
    "chart": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@antv/mcp-server-chart"]
    }
  }
}
```
- 名称用 `chart`（界面显示简洁）；transport 按 stdio 校验规则（有 `command` 即可，`type` 字段保留明确性）。

## 2. 移除当前内置 MCP（用户级配置）
- 编辑 `C:/Users/qikai/.deepagents/.mcp.json`，删除 `my-streamable-http-server` 条目（该文件属于用户本机环境，我会先展示修改后内容再写入）。
- 删除后该文件 `mcpServers` 为空对象，MCP 列表页「内置 / 文件」组将只显示新的 `chart`。

## 3. 说明
- `@antv/mcp-server-chart` 运行时通过 `npx -y` 拉取，需要构建机/运行环境可访问 npm registry；首次调用图表工具时会有下载延迟。
- 无需修改 core/server/web 代码；验证方式：重启 server 后打开扩展管理 → MCP，确认内置组显示 `chart`（stdio, npx -y @antv/mcp-server-chart）且连接探测正常。