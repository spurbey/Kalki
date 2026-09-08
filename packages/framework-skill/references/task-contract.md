# Task Contract

`task.md` is the reviewed statement of intent. Keep it short and include:

- Objective
- Inputs and date range
- Source expectations
- Requested tables and output
- Acceptance checks
- Explicit non-goals

Normalize one UTF-8 BOM away and convert CRLF or CR to LF before computing SHA-256. Use the exact normalized text in both the hash and `task_markdown` sent by `task_cli`; do not reconstruct or shorten the string between those values.

Register the authored task from its workspace instead of assembling the MCP payload in the model turn:

```bash
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.task_cli register
```

The command reads `.kalki/workspace.json` for the current task id, preserves the normalized task text, and prints one compact registration manifest.

Do not put credentials, raw source responses, implementation code, or scratch notes in `task.md`.
