# Task Contract

`task.md` is the reviewed statement of intent. Keep it short and include:

- Objective
- Inputs and date range
- Source expectations
- Requested tables and output
- Acceptance checks
- Explicit non-goals

Normalize one UTF-8 BOM away and convert CRLF or CR to LF before computing SHA-256. Register the normalized Markdown, workspace-relative path, and lowercase hash through `register_task`.

Do not put credentials, raw source responses, implementation code, or scratch notes in `task.md`.
