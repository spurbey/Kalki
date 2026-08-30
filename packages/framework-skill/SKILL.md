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
- Reuse the current task id returned by `get_workbook_context`; do not register a duplicate task after recovery.
- Inspect the workbook MCP tool list before calling a command. The current slice implements every workflow tool except `promote_skill`.
- Use `kalki_runtime.schema_loader` and `pipeline_cli lint` for contract hashes. Never hand-roll schema or pipeline hashes.

## State-Aware Runbook

1. Call `get_workbook_context` with the workbook id provided in the session instructions. Never guess it.
2. Scaffold the workspace with the returned task id, then install the small runtime dependency set:

   ```bash
   python /opt/tf/skills/kalki-framework/scripts/scaffold_task.py --workspace "$PWD" --workbook-id <workbook-id> --task-id <task-id>
   python -m pip install --disable-pip-version-check --quiet --target "$PWD/.kalki/deps" -r /opt/tf/skills/kalki-framework/requirements.txt
   ```

3. Align the request and author `task.md`; call `register_task`.
4. Ask the canonical task review question and wait for the user.
5. Explore the unfamiliar source with Playwright, inspect relevant network requests, and save compact evidence under `research/`.
6. Author the complete schema set, lint it, and call `register_schema` once with every table.
7. Ask the schema review question and wait for the user.
8. Generate operators from the recorded evidence and author one pipeline YAML. Source-only workflows use `transforms: []`.
9. Run the pipeline CLI with `PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client"`.
10. For a browser-backed source, navigate the reviewed data URL directly before execution. Create a test run with `start_run`, then run the CLI test command with `--limit 5`.
11. Read the compact manifest and at most five envelopes per table, then call `complete_run`. Pass the manifest as an object and each full envelope with `data`, `dedupe_key`, and `provenance`, not JSON strings or data-only rows. Show the persisted result; test rows remain sandbox-only.
12. Create a production run with the same hashes, ask the explicit production review question, and wait for the user's answer.
13. After approval, run `start-production` with that production run ID. It checks authorization before reading the source.
14. Run `next-batch` until its compact manifest reports `state=ready_to_finalize`.
15. Run `finalize`; it records artifact metadata and completes the production run.

Skill promotion remains unavailable until `promote_skill` appears in `tools/list`.

## Tool Boundaries

- Workbook MCP owns durable workbook state.
- Playwright MCP owns browser exploration and browser-backed collection.
- Shell and Python own task files and deterministic data processing.
- Generated operators never connect to SQLite or call workbook mutation tools.
- The root coordinator calls navigation and interaction tools directly. A generated source operator may use `mcp_client.call_tool` only with safe Playwright read tools to consume responses already captured by that browser session.
- Do not bypass TrueForge approval checks or call `browser_navigate`, `browser_evaluate`, or other destructive tools from Code Mode.
- A Playwright tool `filename` is written on the MCP host, not inside Daytona. Do not treat it as a sandbox workspace file.

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
