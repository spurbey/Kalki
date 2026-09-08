# Task Contract

`task.md` is the reviewed statement of intent. Keep it short and include:

- Objective
- Inputs and date range
- Source expectations
- Requested tables and output
- Acceptance checks
- Explicit non-goals

Normalize one UTF-8 BOM away and convert CRLF or CR to LF before computing SHA-256. Use the exact normalized text in both the hash and `task_markdown` passed to `register_task`; do not reconstruct or shorten the string between those values.

For a task file, compute the value without inspecting runtime internals:

```bash
python -c 'from pathlib import Path; import hashlib; text=Path("task.md").read_text(encoding="utf-8-sig").replace("\r\n","\n").replace("\r","\n"); print(hashlib.sha256(text.encode("utf-8")).hexdigest())'
```

Do not put credentials, raw source responses, implementation code, or scratch notes in `task.md`.
