---
name: kalki-framework
description: Build reviewed web-research workflows that keep raw data in files and publish compact workbook state.
---

# Kalki Framework

## Contract

- Work inside the current task workspace. Never assume `/workspace`.
- Keep authored files under `task.md`, `research/`, `schemas/`, `operators/`, `pipelines/`, `runs/`, and `artifacts/`.
- Use Playwright for source access and deterministic Python for parsing, validation, and transformation.
- Generate source-specific operators from observed evidence. Do not invent endpoints, fields, or selectors.
- Keep full records in JSONL files. Return only compact manifests and bounded review samples.
- Only the root coordinator asks the user questions or interprets an answer.
- Call `get_workbook_context` at the start of each stage and after compaction or recovery.
- Inspect the workbook MCP tool list before calling a command. The current slice implements `get_workbook_context`, `register_task`, `register_schema`, `start_run`, and test-mode `complete_run`.

## State-Aware Runbook

1. Align the request and author `task.md`; call `register_task`.
2. Ask the canonical task review question and wait for the user.
3. Explore the unfamiliar source with Playwright, inspect relevant network requests, and save compact evidence under `research/`.
4. Author the complete schema set, lint it, and call `register_schema` once with every table.
5. Ask the schema review question and wait for the user.
6. Generate operators from the recorded evidence and author one pipeline YAML.
7. Run `python -m kalki_runtime.pipeline_cli lint --pipeline <path>`.
8. For a browser-backed source, navigate the reviewed data URL directly before execution. Create a test run with `start_run`, then run `python -m kalki_runtime.pipeline_cli test --pipeline <path> --run-id <id> --limit 5`.
9. Read the compact manifest and at most five envelopes per table, then call `complete_run`. Pass the manifest as an object and each full envelope with `data`, `dedupe_key`, and `provenance`, not JSON strings or data-only rows. Show the persisted result; test rows remain sandbox-only.

Production authorization, publication, production finalization, and skill promotion are not available until their workbook tools appear in `tools/list`.

## Tool Boundaries

- Workbook MCP owns durable workbook state.
- Playwright MCP owns browser exploration and browser-backed collection.
- Shell and Python own task files and deterministic data processing.
- Generated operators never connect to SQLite or call workbook mutation tools.
- The root coordinator calls navigation and interaction tools directly. A generated source operator may use `mcp_client.call_tool` only with safe Playwright read tools to consume responses already captured by that browser session.
- Do not bypass TrueForge approval checks or call `browser_navigate`, `browser_evaluate`, or other destructive tools from Code Mode.

## Large-Data Rules

- Do not paste raw API responses or JSONL files into the conversation.
- Read only the rows needed for review.
- Every CLI command prints one compact JSON object to stdout.
- Put diagnostics on stderr and redact credentials.

## References

- Task authoring: `references/task-contract.md`
- Schemas: `references/schema-format.md`
- Operators: `references/operator-contracts.md`
- Pipelines and CLI: `references/pipeline-format.md`
- Browser research: `references/browser-mcp.md`
- Workbook calls from the sandbox: `references/mcp-code-mode.md`
- Provenance: `references/provenance.md`
