# Operator Contracts

Generated code imports framework types instead of redefining them:

```python
from datetime import datetime, timezone
from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance
```

`SourceOperator` and `Transformer` are structural protocols, not base classes.

## Canonical Source Operator Template

A source operator exposes a zero-argument class with a `collect(self, context: RunContext)` generator.
It fetches reviewed URLs through `context.browser.fetch_pages()`, extracts entities using standard library tools (`re`, `json`, `html`, `urllib.parse`), and yields `RecordEnvelope` instances:

```python
import html
import json
import re
from datetime import datetime, timezone
from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance


class SourceOperator:
    def collect(self, context: RunContext):
        # Reviewed target URLs from exploration evidence
        urls = [
            "https://example.com/catalog/item-1",
            # add reviewed entity URLs
        ]

        # 1. Fetch reviewed URLs in batches of at most 5 through the shared browser
        pages = context.browser.fetch_pages(urls[:5], max_chars=120_000)

        for page in pages:
            if page.get("error"):
                continue
            html_content = page.get("body") or ""
            target_url = page.get("url") or urls[0]

            # 2. Extract structured records matching the registered schema
            # Parse based on the observed evidence (embedded JSON, semantic HTML, or data attributes):
            items = []
            # ... parse entities into dicts matching schema columns ...

            for item in items:
                primary_id = str(item.get("id") or item.get("sku") or item.get("name") or "")
                if not primary_id:
                    continue

                # 3. Yield RecordEnvelope with schema-matching data and direct provenance
                # dedupe_key must match the schema primary_key column value:
                yield RecordEnvelope(
                    data=item,
                    dedupe_key=primary_id,
                    provenance=Provenance(
                        kind="direct",
                        source_url=target_url,
                        retrieved_at=datetime.now(timezone.utc).isoformat(),
                        source_record_id=primary_id,
                    ),
                )
```

## RecordEnvelope and Provenance Specification

Every yield must be a valid `RecordEnvelope`:
* `data`: dict matching the registered table schema columns. Primary key values must match the column types.
* `dedupe_key`: string matching the primary key value.
  * For single-column primary keys (e.g. `primary_key: [id]` or `primary_key: [sku]`): `dedupe_key = str(data[pk_col])`.
  * For composite primary keys: import `from kalki_runtime.schema_loader import dedupe_key` and use `dedupe_key(schema, data)`.
* `provenance`: `Provenance` object with:
  * `kind="direct"` for source operators (`kind="derived"` for transformers).
  * `source_url`: full HTTPS URL where the data originated.
  * `retrieved_at`: ISO-8601 UTC timestamp with timezone (e.g. `datetime.now(timezone.utc).isoformat()`).
  * `source_record_id`: optional string identifier from the source.
  * `parents`: direct provenance MUST have `parents=()`.

## Linter and Import Restrictions

The pipeline AST linter strictly prohibits:
* `httpx`, `requests`, `socket`, `subprocess`, `urllib.request`.

Permitted libraries:
* Standard library: `json`, `re`, `html`, `datetime`, `urllib.parse`, `math`, `itertools`, `hashlib`, etc. (preferred: zero external runtime dependencies needed).
* Pre-installed dependencies: `pydantic`, `yaml`.

## Operational Rules & Guardrails

* **Standard-Library Extraction**: Prefer Python standard library modules (`re`, `json`, `html`, `urllib.parse`) for parsing observed HTML or embedded JSON payloads. Avoid installing heavy external DOM parsing packages.
* **Authoritative Source Pages**: Extract detailed entity records from authoritative product, catalog, or entity pages rather than relying on high-level search or index cards that omit detail fields.
* **No DOM Parsing Dependencies**: Do NOT `pip install` or import external HTML parsers (`BeautifulSoup`, `lxml`). Standard library regex + JSON parsing is faster, has 0 dependency overhead, and directly extracts structured records.
* Read configuration from `context.config`.
* For a browser-backed source, the coordinator navigates to the reviewed source URL before execution, and the operator calls `context.browser.fetch_pages(urls)` in batches of at most five.
* Source-only workflows use `transforms: []`.
* Do not call navigation, evaluation, or interaction tools from Code Mode; TrueForge blocks those tools as destructive.
* Do not inspect `/workspace/kalki_runtime/*.py` via bash; all runtime types and rules are documented above.

