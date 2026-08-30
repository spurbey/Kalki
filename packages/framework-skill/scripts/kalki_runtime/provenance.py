from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ProvenanceParent:
    table_slug: str
    dedupe_key: str


@dataclass(frozen=True)
class Provenance:
    kind: Literal["direct", "derived"]
    source_url: str
    retrieved_at: str
    parents: tuple[ProvenanceParent, ...] = ()
    source_record_id: str | None = None
    evidence_path: str | None = None
    source_hash: str | None = None
