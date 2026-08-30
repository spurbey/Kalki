---
name: kalki-framework
description: Build reviewed web-research workflows that keep raw data in files and publish compact workbook state.
---

# Kalki Framework

## Contract

- Work inside the current task workspace. Never assume `/workspace`.
- Keep authored files under `task.md`, `research/`, `schemas/`, `operators/`, `pipelines/`, `runs/`, and `artifacts/`.
- Use Playwright for source reconnaissance and deterministic Python for collection and transformation.
- Keep full records in JSONL files. Return only compact manifests and bounded review samples.
- Only the root coordinator asks the user questions or interprets an answer.
- Call `get_workbook_context` at the start of each stage and after compaction or recovery.
- Inspect the workbook MCP tool list before calling a command. The current slice implements `get_workbook_context`, `register_task`, `register_schema`, and `start_run`.

## State-Aware Runbook

1. Align the request and author `task.md`; call `register_task`.
2. Ask the canonical task review question and wait for the user.
3. Explore the source with Playwright and save compact evidence under `research/`.
4. Author the complete schema set, lint it, and call `register_schema` once with every table.
5. Ask the schema review question and wait for the user.
6. Author operators and one pipeline YAML.
7. Run `python -m kalki_runtime.pipeline_cli lint --pipeline <path>`.
8. Create a test run with `start_run`, then run `python -m kalki_runtime.pipeline_cli test --pipeline <path> --run-id <id> --limit 5`.
9. Show the compact manifest and at most five records per table. Test rows remain sandbox-only.

Production authorization, publication, finalization, and skill promotion are not available until their workbook tools appear in `tools/list`.

## Tool Boundaries

- Workbook MCP owns durable workbook state.
- Playwright MCP owns browser interaction and source evidence.
- Shell and Python own task files and deterministic data processing.
- Generated operators never connect to SQLite or call workbook mutation tools.

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
