# MCP Code Mode

The Daytona image provides:

```text
/usr/local/bin/mcp-client
/opt/tf/mcp-client/mcp_client.py
```

Discover deferred tools through TrueForge before entering Code Mode. The sandbox CLI invokes a known tool; it does not list tools:

```bash
python /opt/tf/mcp-client/mcp_client.py call-tool <server> <tool> '<args-json>'
```

Invoke the script through Python because the global symlink can inherit Windows line endings in a locally built TrueForge image.

Prefer direct coordinator tool calls for bounded browser reconnaissance and small payloads. Use Code Mode when arguments come from workspace files or tool output must be reduced before entering model context.

For browser-backed operators:

1. The coordinator directly calls `browser_navigate` before starting the pipeline.
2. The operator imports `call_tool` from `mcp_client` and calls only safe read tools such as `browser_network_requests` and `browser_network_request`.
3. Playwright text responses may arrive as a list of content objects. Read each object's `.text`, remove the leading `### Result` line, and parse the remaining JSON without printing it.

`browser_navigate`, `browser_evaluate`, and other destructive Playwright tools are intentionally unavailable in Code Mode. Never change `TFY_ENABLE_AGENT_APPROVALS` or call private `mcp_client` functions to bypass this boundary.

Never print bearer tokens, connector settings, full table rows, or raw tool-result files. Check `tools/list` before relying on a command because Kalki exposes only implemented workflow stages.
