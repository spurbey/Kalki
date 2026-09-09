# Operator Contracts

Generated code imports framework types instead of redefining them:

```python
from datetime import datetime, timezone
from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance
```

`SourceOperator` and `Transformer` are structural protocols, not base classes.

## Canonical Source Operator Template

A source operator exposes a zero-argument class with a `collect(self, context: RunContext)` generator:

```python
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance


class SourceOperator:
    def collect(self, context: RunContext):
        target_url = "https://news.ycombinator.com/news"

        # 1. Fetch up to 5 reviewed URLs through the shared browser tab
        pages = context.browser.fetch_pages([target_url], max_chars=80_000)
        page = pages[0]
        html_body = page.get("body") or ""

        # Or read pre-saved research evidence:
        # html_body = context.browser.fetch_research_json("research/captures/source.html")

        # 2. Parse items inside the sandbox
        soup = BeautifulSoup(html_body, "html.parser")
        for row in soup.select("tr.athing"):
            item_id = row.get("id")
            title_elem = row.select_one("span.titleline > a")
            if not item_id or not title_elem:
                continue

            # 3. Yield RecordEnvelope with schema-matching data and direct provenance
            yield RecordEnvelope(
                data={
                    "item_id": int(item_id),
                    "title": title_elem.get_text(strip=True),
                    "url": title_elem.get("href"),
                },
                dedupe_key=str(item_id),
                provenance=Provenance(
                    kind="direct",
                    source_url=target_url,
                    retrieved_at=datetime.now(timezone.utc).isoformat(),
                    source_record_id=str(item_id),
                ),
            )
```

## RecordEnvelope and Provenance Specification

Every yield must be a valid `RecordEnvelope`:
* `data`: dict matching the registered table schema columns. Primary key values must match the column types.
* `dedupe_key`: string matching the primary key value (e.g. `str(item_id)`).
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
* Standard library: `json`, `re`, `datetime`, `urllib.parse`, `math`, `itertools`, `hashlib`, etc.
* Installed dependencies: `bs4` (`BeautifulSoup`), `pydantic`, `yaml`.

## Operational Rules

* Read configuration from `context.config`.
* For a browser-backed source, the coordinator navigates to the reviewed source URL before execution, and the operator calls `context.browser.fetch_pages(urls)` in batches of at most five.
* Source-only workflows use `transforms: []`.
* Do not call navigation, evaluation, or interaction tools from Code Mode; TrueForge blocks those tools as destructive.
* Do not inspect `/workspace/kalki_runtime/*.py` via bash; all runtime types and rules are documented above.
