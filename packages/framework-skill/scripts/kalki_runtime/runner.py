import hashlib
import importlib.util
from datetime import datetime
from itertools import islice
from pathlib import Path
from urllib.parse import urlparse

from .contracts import RecordEnvelope, RunContext
from .http_client import AllowlistedHttpClient, NoNetworkHttpClient
from .pipeline_spec import LoadedPipeline, workspace_path
from .schema_loader import dedupe_key, validate_data
from .serialization import write_json, write_jsonl


def _load_class(workspace: Path, reference: str) -> type:
    relative, class_name = reference.split(":")
    path = workspace_path(workspace, relative)
    module_name = f"kalki_generated_{hashlib.sha256(str(path).encode()).hexdigest()[:12]}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"cannot load {reference}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = getattr(module, class_name, None)
    if not isinstance(target, type):
        raise ValueError(f"class was not found: {reference}")
    return target


def _validate_provenance(record: RecordEnvelope) -> None:
    provenance = record.provenance
    if urlparse(provenance.source_url).scheme != "https":
        raise ValueError("provenance source_url must use HTTPS")
    timestamp = datetime.fromisoformat(provenance.retrieved_at.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("provenance retrieved_at requires a timezone")
    if provenance.kind == "direct" and provenance.parents:
        raise ValueError("direct provenance cannot contain parents")
    if provenance.kind == "derived" and not provenance.parents:
        raise ValueError("derived provenance requires a parent")
    if provenance.source_hash and (len(provenance.source_hash) != 64 or any(c not in "0123456789abcdef" for c in provenance.source_hash)):
        raise ValueError("source_hash must be lowercase SHA-256")


def _validated_records(records: list[RecordEnvelope], schema: dict[str, object]) -> list[RecordEnvelope]:
    seen: set[str] = set()
    for record in records:
        if not isinstance(record, RecordEnvelope) or not isinstance(record.data, dict) or not record.dedupe_key:
            raise ValueError("operator returned an invalid RecordEnvelope")
        validate_data(schema, record.data)
        if record.dedupe_key != dedupe_key(schema, record.data):
            raise ValueError("record dedupe_key does not match the schema primary key")
        if record.dedupe_key in seen:
            raise ValueError(f"duplicate dedupe_key: {record.dedupe_key}")
        _validate_provenance(record)
        seen.add(record.dedupe_key)
    return records


def run_test(pipeline: LoadedPipeline, run_id: str, limit: int) -> dict[str, object]:
    source = pipeline.data["source"]
    transforms = pipeline.data["transforms"]
    execution = pipeline.data["execution"]
    client = AllowlistedHttpClient(
        allowed_hosts=set(execution["allowed_hosts"]),
        timeout=execution["request_timeout_seconds"],
        max_bytes=execution["max_response_bytes"],
    )
    source_class = _load_class(pipeline.workspace, source["operator"])
    source_context = RunContext(
        workspace=pipeline.workspace,
        run_id=run_id,
        mode="test",
        step_id=source["id"],
        input_table=None,
        output_table=source["table"],
        config=source["config"],
        limit=limit,
        http=client,
    )
    source_records = list(islice(source_class().collect(source_context), limit))
    if len(source_records) != limit:
        raise ValueError(f"source returned {len(source_records)} records; expected {limit}")
    source_records = _validated_records(source_records, pipeline.schemas[source["table"]])

    run_directory = pipeline.workspace / "runs" / run_id
    source_path = run_directory / "source.jsonl"
    source_sha256 = write_jsonl(source_path, source_records)
    table_records: dict[str, list[RecordEnvelope]] = {source["table"]: source_records}
    table_files: dict[str, dict[str, object]] = {
        source["table"]: {
            "path": source_path.relative_to(pipeline.workspace).as_posix(),
            "sha256": source_sha256,
            "count": len(source_records),
        }
    }

    for transform in transforms:
        transform_class = _load_class(pipeline.workspace, transform["transformer"])
        context = RunContext(
            workspace=pipeline.workspace,
            run_id=run_id,
            mode="test",
            step_id=transform["id"],
            input_table=transform["input_table"],
            output_table=transform["output_table"],
            config=transform["config"],
            limit=None,
            http=NoNetworkHttpClient(),
        )
        records = list(transform_class().transform(iter(table_records[transform["input_table"]]), context))
        records = _validated_records(records, pipeline.schemas[transform["output_table"]])
        output_path = run_directory / "derived" / f"{transform['output_table']}.jsonl"
        table_files[transform["output_table"]] = {
            "path": output_path.relative_to(pipeline.workspace).as_posix(),
            "sha256": write_jsonl(output_path, records),
            "count": len(records),
        }
        table_records[transform["output_table"]] = records

    checkpoint_path = run_directory / "checkpoint.json"
    manifest_path = run_directory / "manifest.json"
    checkpoint = {
        "version": 1,
        "run_id": run_id,
        "mode": "test",
        "pipeline_path": pipeline.relative_path,
        "phase": "ready_to_finalize",
        "tables": table_files,
    }
    write_json(checkpoint_path, checkpoint)
    manifest = {
        "version": 1,
        "ok": True,
        "command": "test",
        "run_id": run_id,
        "mode": "test",
        "state": "ready_to_finalize",
        "task_hash": pipeline.task_hash,
        "schema_hash": pipeline.schema_hash,
        "pipeline_hash": pipeline.pipeline_hash,
        "counts": {
            "source_records": len(source_records),
            "derived_records": sum(len(records) for table, records in table_records.items() if table != source["table"]),
        },
        "paths": {
            "manifest": manifest_path.relative_to(pipeline.workspace).as_posix(),
            "checkpoint": checkpoint_path.relative_to(pipeline.workspace).as_posix(),
        },
        "tables": table_files,
        "done": True,
        "next_action": "review_test",
        "error": None,
    }
    write_json(manifest_path, manifest)
    return manifest
