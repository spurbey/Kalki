# Task Contract & Living Memory

`task.md` is the agent's persistent state machine and working blackboard across turns. It has two layers:

## 1. Canonical Task Contract (Top Section)

Authored during alignment and reviewed by the user. Kept concise and structured:
- Objective
- Inputs and date range
- Source expectations
- Requested tables and output
- Acceptance checks
- Explicit non-goals

The canonical contract hash (`task_hash`) is computed strictly on this canonical section (everything above `---` or before `## Living Memory` / `## Exploration Findings`). Normalizes one UTF-8 BOM away and converts CRLF or CR to LF before computing SHA-256.

Register the authored task from its workspace:

```bash
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.task_cli register
```

## 2. Living Memory & Exploration Findings (Evolving Section)

Appended and updated by the agent at every turn boundary below `---` or `## Living Memory`:
- `### Exploration Findings`: Observed source architecture (SSR, SPA props, JSON-LD), representative entity URLs, exact data paths/selectors, verified schema fields, and seed discovery strategy.
- `### Implementation`: Schema paths, operator files, tested output keys, and pipeline graph.
- `### Progress State`: Active phase checklist.

Updating living memory preserves the canonical `task_hash`, allowing the agent to continuously maintain state across turns without invalidating user reviews or failing production gates.

Never place secrets, credentials, or raw multi-megabyte page dumps in `task.md`. Keep raw captures under `research/captures/`.
