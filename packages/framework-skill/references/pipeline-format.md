# Pipeline Format

One task uses one pipeline YAML. Every key across `pipeline`, `source`, `transforms`, and `execution` is validated strictly against Pydantic models. Omitting or misspelling any key will cause `pipeline_cli lint` to fail.

## Canonical Pipeline YAML Template

For source-only workflows (where the source table is the final output), use `transforms: []`:

```yaml
version: 1
pipeline:
  slug: catalog-items
  name: Catalog Items Pipeline
  task_path: task.md
  support_paths: []
source:
  id: collect-catalog-items
  table: catalog-items
  schema_path: schemas/catalog-items.yaml
  operator: operators/source.py:SourceOperator
  config: {}
transforms: []
execution:
  test_limit: 5
  publication_batch_size: 50
  request_timeout_seconds: 30
  request_max_attempts: 3
  request_backoff_seconds: 1.0
  max_response_bytes: 5000000
  allowed_hosts:
    - example.com
```

Class references use `<workspace-relative-python-file>:<ClassName>`.

## Complete Command Workflow

```bash
# 1. Lint the pipeline (no network; verifies AST, files, schemas, and hashes)
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli lint --pipeline pipelines/pipeline.yaml

# 2. Run the bounded 5-record test (writes bounded JSONL and manifest under runs/<run-id>/)
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli test --pipeline pipelines/pipeline.yaml --run-id <run-id> --limit 5

# 3. Complete the test run (automatically bounds samples, enforces table_counts: {}, and advances task state)
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli complete --run-id <run-id>

# 4. (After explicit user approval) Start production execution
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli start-production --pipeline pipelines/pipeline.yaml --run-id <run-id>

# 5. Publish batches until state is ready_to_finalize
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli next-batch --run-id <run-id> --limit 50

# 6. Finalize production (records CSV/lineage/report artifacts and marks run completed)
PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.pipeline_cli finalize --run-id <run-id>
```

## Contract Rules

- `lint` performs no network request. Use the hashes printed by `pipeline_cli lint`.
- `test` writes bounded JSONL and a compact manifest under `runs/<run-id>/` and never publishes formal rows.
- `complete` reads `runs/<run-id>/manifest.json` and sample rows, and issues `complete_run` with `table_counts: {}`. Never construct manual JSON payloads for `complete_run`.
- `start-production` verifies explicit consent before source access. Each `next-batch` invocation publishes at most 50 rows from one table and advances its checkpoint only after confirmation.
- Do not inspect `/workspace/kalki_runtime/*.py` via bash; all pipeline fields and commands are defined above.
