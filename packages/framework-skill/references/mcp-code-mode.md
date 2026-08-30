# MCP Code Mode

The Daytona image provides:

```text
/usr/local/bin/mcp-client
/opt/tf/mcp-client/mcp_client.py
```

Use `mcp-client` to list and call configured workbook tools without exposing connector credentials. Prefer direct coordinator tool calls for small payloads. Use Code Mode when arguments are generated from workspace files.

Never print bearer tokens, connector settings, full table rows, or raw tool-result files. Check `tools/list` before relying on a command because Kalki exposes only implemented workflow stages.
