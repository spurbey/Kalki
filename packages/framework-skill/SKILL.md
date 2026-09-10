---
name: kalki-framework
description: Build reviewed web-research workflows that keep raw data in files and publish compact workbook state.
---

# Kalki Framework

## Contract

- Work inside the current task workspace. Never assume `/workspace`.
- Keep authored files under `task.md`, `research/`, `schemas/`, `operators/`, `pipelines/`, `runs/`, and `artifacts/`.
- Living Memory Protocol: `task.md` is the agent's only working blackboard across turns. Keep the user request at the top. Below `---` or `## Living Memory`, update findings incrementally:
  1. Record source architecture, URL, DOM/JSON paths, selectors, and pagination under `## Exploration Findings` immediately after inspecting each source or representative entity.
  2. Record the schema definition table (`| Field Name | Type | Required | Notes |`) under `## Implementation -> ### Schema` immediately after registering the schema.
  3. Record operator file paths, roles, and intermediate models under `## Implementation -> ### Operators` upon authoring operators.
  4. Record verified sample output rows under `## Implementation -> ### Test Verification` upon completing the test run.
- Deterministic Seed Strategy: When a directory or catalog has no useful list in the page, use reviewed detail URLs or a public sitemap. Do not spend the turn reverse-engineering an undocumented search index or token.
- Use Playwright for source access and deterministic Python for parsing, validation, and transformation.
- Generate source-specific operators from observed evidence. Do not invent endpoints, fields, or selectors.
- Keep full records in JSONL files. Return only compact manifests and bounded review samples.
- Only the root coordinator asks the user questions or interprets an answer.
- Call `get_workbook_context` at the start of each stage and after compaction or recovery.
- Reuse the current task id returned by `get_workbook_context`; do not register a duplicate task after recovery.
- Use the preloaded Kalki workbook and browser research tools directly. Do not call deferred-tool discovery or raw Playwright tools; `promote_skill` may still be unavailable.
- Use `kalki_runtime.schema_loader` and `pipeline_cli lint` to validate the workflow. Do not hand-build registration payloads.
- Soft No-Progress Rule: If two attempts using the same strategy fail, checkpoint observed evidence and change strategy immediately. Do not repeatedly decode, parse, or regex-split the same raw payload with scratch scripts.
- Stage Discipline: Keep each turn focused on exactly one workflow stage: exploration, schema, build, or test. Complete the active stage or checkpoint evidence before initiating subsequent steps.
- Normalized Browser Acquisition: Use `kalki_runtime.browser.BrowserAcquisitionClient` (or `context.browser`) for browser-backed data access. Never manually parse MCP `TextContent` objects or write ad-hoc CLI decoding loops in bash.
- Zero-Dependency State Extraction: For pages that embed structured state (JSON-LD, framework state, or SSR attributes), extract only the needed fields with standard library `re`, `html.unescape`, and `json.loads(..., strict=False)`.
- Primary Evidence Priority: Extract details from the authoritative page or a deterministic endpoint confirmed during research. Do not guess undocumented APIs.

## State-Aware Runbook

1. Call `get_workbook_context` with the workbook id provided in the session instructions. Never guess it.
2. Scaffold the workspace with the returned task id, then install the small runtime dependency set:

   ```bash
   python /opt/tf/skills/kalki-framework/scripts/scaffold_task.py --workspace "$PWD" --workbook-id <workbook-id> --task-id <task-id>
   python -m pip install --disable-pip-version-check --quiet --target "$PWD/.kalki/deps" -r /opt/tf/skills/kalki-framework/requirements.txt
   ```

3. Read `references/task-contract.md`. Align the request and author `task.md`, then run `PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.task_cli register`.
4. Ask the canonical task review question and wait for user approval.
5. Read `references/browser-mcp.md`. Explore the unfamiliar source with compact `browser_research_*` tools. Stop when the requested fields are observed on one representative entity. Persist one bounded evidence sample with `research_cli capture`; do not paginate or browse multiple detail pages to estimate volume.
6. Immediately update `task.md` with the representative URL, page architecture, data paths/selectors, verified fields, and seed strategy, then run `task_cli register` again. Do not calculate a hash in the agent turn.
7. Read `references/schema-format.md`. Author `schemas/<table-slug>.yaml` from the verified fields in `task.md`, run `schema_cli register`, update `task.md` with the schema and run `task_cli register`, then ask the schema review question.
8. Read `task.md` and `references/operator-contracts.md`. Author the operator offline from saved evidence, update `task.md` with operator paths and seed URLs, then author `pipelines/pipeline.yaml`. Source-only workflows use `transforms: []`.
9. Run the pipeline CLI lint with `PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client"`.
10. For a browser-backed source, use `browser_research_navigate` on the reviewed data URL immediately before execution. Create a test run with `start_run`, then run `pipeline_cli test --limit 15`.
11. Run `PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli complete --run-id <id>`. The command reads the test manifest and sample envelopes, submits `complete_run` with `table_counts: {}`, and advances the task to `awaiting_production_confirmation`. Test rows remain sandbox-only.
12. Create a production run with the same hashes. Only after `start_run` returns `awaiting_confirmation`, ask the explicit production review question and wait for the user's answer.
13. After approval, run `start-production` with that production run ID.
14. Run `next-batch` until its compact manifest reports `state=ready_to_finalize`.
15. Run `finalize`; it records artifact metadata and completes the production run.

Skill promotion remains unavailable until `promote_skill` appears in `tools/list`.

## Tool Boundaries

- Workbook MCP owns durable workbook state.
- Kalki browser research tools own bounded coordinator exploration; the internal Playwright client owns the headed shared tab.
- Shell and Python own task files and deterministic data processing.
- Generated operators never connect to SQLite or call workbook mutation tools.
- The root coordinator uses `browser_research_*` for navigation, bounded observation, interaction, and request discovery. A generated source operator may use `context.browser.fetch_pages()` to fetch up to five reviewed URLs through the current shared browser tab; it parses the bounded bodies inside the sandbox.
- The coordinator must navigate the shared tab to the reviewed source before the pipeline runs. The operator does not navigate, evaluate arbitrary JavaScript, or interact with the page.
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
