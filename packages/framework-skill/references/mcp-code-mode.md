# MCP Code Mode

The Daytona image provides:

```text
/usr/local/bin/mcp-client
/opt/tf/mcp-client/mcp_client.py
```

Discover deferred tools through TrueForge before entering Code Mode. The sandbox CLI invokes a known tool; it does not list tools:

```bash
mcp-client call-tool <server> <tool> '<args-json>'
```

Prefer direct coordinator tool calls for bounded browser reconnaissance and small payloads. Use Code Mode when arguments come from workspace files or tool output must be reduced before entering model context.

Never print bearer tokens, connector settings, full table rows, or raw tool-result files. Check `tools/list` before relying on a command because Kalki exposes only implemented workflow stages.
