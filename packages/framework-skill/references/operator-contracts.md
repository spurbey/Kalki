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

Read configuration from `context.config`. Sources use `context.http` only for endpoints supported by recorded research evidence; transformers perform no network calls. Do not write JSONL directly, access SQLite, read secrets, or guess the workspace path.
