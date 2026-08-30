import hashlib
import os
from pathlib import Path

from .contracts import RecordEnvelope
from .schema_loader import canonical_json


def envelope_dict(record: RecordEnvelope) -> dict[str, object]:
    provenance = record.provenance
    return {
        "data": record.data,
        "dedupe_key": record.dedupe_key,
        "provenance": {
            "kind": provenance.kind,
            "source_url": provenance.source_url,
            "retrieved_at": provenance.retrieved_at,
            **({"source_record_id": provenance.source_record_id} if provenance.source_record_id else {}),
            **({"evidence_path": provenance.evidence_path} if provenance.evidence_path else {}),
            **({"source_hash": provenance.source_hash} if provenance.source_hash else {}),
            "parents": [
                {"table_slug": parent.table_slug, "dedupe_key": parent.dedupe_key}
                for parent in provenance.parents
            ],
        },
    }


def _replace(path: Path, data: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> str:
    return _replace(path, f"{canonical_json(value)}\n".encode("utf-8"))


def write_jsonl(path: Path, records: list[RecordEnvelope]) -> str:
    data = "".join(f"{canonical_json(envelope_dict(record))}\n" for record in records).encode("utf-8")
    return _replace(path, data)
