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

Read configuration from `context.config`. For a browser-backed source, the coordinator navigates to the reviewed URL before execution and the operator reads the captured response through safe Playwright tools exposed by `mcp_client`. Transformers perform no network calls.

Do not call navigation, evaluation, or interaction tools from Code Mode; TrueForge blocks those tools as destructive. Do not write JSONL directly, access SQLite, read secrets, bypass approval checks, or guess the workspace path.
