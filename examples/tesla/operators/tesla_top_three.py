from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance, ProvenanceParent


class TeslaTopThreeTransformer:
    def transform(self, records, context: RunContext):
        count = int(context.config.get("count", 3))
        selected = sorted(records, key=lambda record: (-record.data["high"], record.data["date"]))[:count]
        if len(selected) != count:
            raise ValueError(f"top-three transform requires {count} source records")

        for rank, source in enumerate(selected, start=1):
            yield RecordEnvelope(
                data={
                    "rank": rank,
                    "date": source.data["date"],
                    "high": source.data["high"],
                    "volume": source.data["volume"],
                    "open": source.data["open"],
                    "close": source.data["close"],
                    "currency": source.data["currency"],
                },
                dedupe_key=str(rank),
                provenance=Provenance(
                    kind="derived",
                    source_url=source.provenance.source_url,
                    retrieved_at=source.provenance.retrieved_at,
                    parents=(ProvenanceParent(table_slug="tesla-history", dedupe_key=source.dedupe_key),),
                ),
            )
