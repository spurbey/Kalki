# Provenance

Every `RecordEnvelope` contains `data`, a stable `dedupe_key`, and provenance.

Direct provenance contains:

- `kind: direct`
- final HTTPS source URL
- timezone-aware retrieval timestamp
- optional source record ID, evidence path, and source hash
- no parents

Derived provenance contains `kind: derived` and at least one `{table_slug, dedupe_key}` parent. It inherits the selected source URL and retrieval time.

Do not use local database IDs, run IDs, or row positions as source identity.
