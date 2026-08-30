# Pipeline Format

One task uses one pipeline YAML. It declares:

- `pipeline`: slug, name, `task_path`, and optional support files
- `source`: output table, schema, class reference, and source configuration
- `transforms`: ordered input/output steps
- `execution`: test limit, request limits, and allowed hosts

Class references use `<workspace-relative-python-file>:<ClassName>`.

Current commands:

```bash
python -m kalki_runtime.pipeline_cli lint --pipeline pipelines/tesla.yaml
python -m kalki_runtime.pipeline_cli test --pipeline pipelines/tesla.yaml --run-id <id> --limit 5
```

`lint` performs no network request. `test` writes bounded JSONL and a compact manifest under `runs/<run-id>/` and never publishes formal rows.
