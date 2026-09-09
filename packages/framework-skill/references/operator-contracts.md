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
Modern web apps (e.g. Y Combinator, Inertia.js, Next.js) embed their complete state directly in HTML as JSON. Extract it with standard library `re`, `html.unescape`, and `json.loads(..., strict=False)`—no external HTML parsing libraries required:

```python
import html
import json
import re
from datetime import datetime, timezone
from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance


class SourceOperator:
    def collect(self, context: RunContext):
        urls = [
            "https://www.ycombinator.com/companies/circuithub",
            # add reviewed entity URLs
        ]

        # 1. Fetch reviewed URLs in batches of at most 5 through the shared browser
        pages = context.browser.fetch_pages(urls[:5], max_chars=120_000)

        for page in pages:
            if page.get("error"):
                continue
            html_content = page.get("body") or ""
            target_url = page.get("url") or urls[0]

            # 2. Extract embedded JSON state (e.g. Inertia.js data-page or Next.js __NEXT_DATA__)
            match = re.search(r'<div\s+id="app"\s+data-page="([^"]+)"', html_content)
            if not match:
                continue

            page_data = json.loads(html.unescape(match.group(1)), strict=False)
            company = page_data.get("props", {}).get("company", {})
            company_name = company.get("name", "")

            # 3. Yield RecordEnvelope with schema-matching data and direct provenance
            for founder in company.get("founders", []):
                founder_name = (founder.get("name") or "").strip()
                if not founder_name:
                    continue

                yield RecordEnvelope(
                    data={
                        "founder_name": founder_name,
                        "company_name": company_name,
                        "title": founder.get("title") or "Founder",
                        "bio": founder.get("founder_bio") or None,
                        "linkedin_url": founder.get("linkedin_url") or None,
                    },
                    dedupe_key=f"{company_name}:{founder_name}",
                    provenance=Provenance(
                        kind="direct",
                        source_url=target_url,
                        retrieved_at=datetime.now(timezone.utc).isoformat(),
                        source_record_id=str(founder.get("id") or founder_name),
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
* Standard library: `json`, `re`, `html`, `datetime`, `urllib.parse`, `math`, `itertools`, `hashlib`, etc. (preferred: zero external runtime dependencies needed).
* Pre-installed dependencies: `pydantic`, `yaml`.

## Operational Rules & Guardrails

* **Zero-Dependency State Extraction**: Modern web applications (e.g. Y Combinator) embed complete entity models inside `<div id="app" data-page="...">` or `<script id="__NEXT_DATA__">`. Always extract this embedded JSON with `re`, `html.unescape`, and `json.loads(..., strict=False)`.
* **No Search API Reverse-Engineering**: Do NOT reverse-engineer or rely on external search APIs (e.g. Algolia `algolia.net/1/indexes`). They only return summary search cards and omit entity detail fields (such as founder profiles).
* **No DOM Parsing Dependencies**: Do NOT `pip install` or import external HTML parsers (`BeautifulSoup`, `lxml`). Standard library regex + JSON parsing is faster, has 0 dependency overhead, and directly extracts structured records.
* Read configuration from `context.config`.
* For a browser-backed source, the coordinator navigates to the reviewed source URL before execution, and the operator calls `context.browser.fetch_pages(urls)` in batches of at most five.
* Source-only workflows use `transforms: []`.
* Do not call navigation, evaluation, or interaction tools from Code Mode; TrueForge blocks those tools as destructive.
* Do not inspect `/workspace/kalki_runtime/*.py` via bash; all runtime types and rules are documented above.
