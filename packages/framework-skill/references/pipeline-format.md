# Pipeline Format

One task uses one pipeline YAML. It declares:

- `pipeline`: slug, name, `task_path`, and optional support files
- `source`: output table, schema, class reference, and source configuration
- `transforms`: ordered input/output steps, or `[]` when the source table is the final result
- `execution`: test limit, request limits, and allowed hosts

Class references use `<workspace-relative-python-file>:<ClassName>`.

Current commands:

```bash
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli lint --pipeline pipelines/<name>.yaml
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli test --pipeline pipelines/<name>.yaml --run-id <id> --limit 5
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli start-production --pipeline pipelines/<name>.yaml --run-id <id>
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli next-batch --run-id <id> --limit 50
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli finalize --run-id <id>
```

`lint` performs no network request. `test` writes bounded JSONL and a compact manifest under `runs/<run-id>/` and never publishes formal rows.

Use the hashes printed by `pipeline_cli lint`. Do not reproduce the schema or pipeline hash algorithm in generated task code.

`start-production` verifies explicit consent before source access. Each `next-batch` invocation publishes at most 50 rows from one table and advances its checkpoint only after confirmation. `finalize` records artifact metadata and completes the run after every table is published.
