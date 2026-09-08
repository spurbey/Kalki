# Operator Contracts

Generated code imports framework types instead of redefining them:

```python
from kalki_runtime.contracts import RecordEnvelope, RunContext
```

`SourceOperator` and `Transformer` are structural protocols, not base classes. A source exposes a zero-argument class with:

```python
def collect(self, context: RunContext):
    yield RecordEnvelope(...)
```

A transformer exposes:

```python
def transform(self, records, context: RunContext):
    yield RecordEnvelope(...)
```

Read configuration from `context.config`. For a browser-backed source, the coordinator navigates to the reviewed source before execution and the operator calls `context.browser.fetch_pages(urls)` in batches of at most five. The client returns decoded, bounded page bodies and page-level errors; parse them inside the sandbox and keep full records in JSONL. Transformers perform no network calls.

Do not call navigation, evaluation, or interaction tools from Code Mode; TrueForge blocks those tools as destructive. Do not write JSONL directly, access SQLite, read secrets, bypass approval checks, or guess the workspace path.
