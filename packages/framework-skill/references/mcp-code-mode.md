# MCP Code Mode

The Daytona image provides:

```text
/usr/local/bin/mcp-client
/opt/tf/mcp-client/mcp_client.py
```

The sandbox CLI invokes a known tool; it does not discover or list tools:

```bash
python /opt/tf/mcp-client/mcp_client.py call-tool <server> <tool> '<args-json>'
```

Invoke the script through Python because the global symlink can inherit Windows line endings in a locally built TrueForge image.

The coordinator uses the preloaded `kalki-workbook` browser research tools for reconnaissance. Use Code Mode when arguments come from workspace files or tool output must be reduced before entering model context.

For schema registration, use `python -m kalki_runtime.schema_cli register` from the task workspace. It reads and validates the files under `schemas/` and sends one compact result through the existing `register_schema` tool; do not paste schema objects into a model tool call.

For browser-backed operators:

1. The coordinator calls `browser_research_navigate` before starting the pipeline.
2. The operator uses `context.browser.fetch_pages(urls)` for reviewed browser-backed collection. The helper calls the read-only `kalki-workbook/browser_fetch_pages` bridge and returns bounded page objects.
3. Keep batches at five URLs or fewer and parse the returned body in the sandbox. Do not manually unwrap MCP content objects or print full responses.

The workbook bridge uses compressed transport internally; `context.browser.fetch_pages` returns decoded page bodies.

Raw Playwright tools are intentionally unavailable to the coordinator and Code Mode. Never change `TFY_ENABLE_AGENT_APPROVALS` or call private `mcp_client` functions to bypass this boundary.

Never print bearer tokens, connector settings, full table rows, or raw tool-result files. Use only the commands and tools described by the mounted Kalki skill.
