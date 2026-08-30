import asyncio
import csv
import hashlib
import importlib.util
import io
import json
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path
from urllib.parse import urlparse

from .contracts import RecordEnvelope, RunContext
from .http_client import AllowlistedHttpClient, NoNetworkHttpClient
from .provenance import Provenance, ProvenanceParent
from .pipeline_spec import LoadedPipeline, load_pipeline, workspace_path
from .schema_loader import canonical_json, dedupe_key, hash_json, validate_data
from .serialization import envelope_dict, write_json, write_jsonl, write_text


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

    run_directory = workspace_path(pipeline.workspace, f"runs/{run_id}")
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


def _workbook_call(tool: str, body: dict[str, object]) -> dict[str, object]:
    async def invoke() -> object:
        from mcp_client import call_tool

        return await call_tool("kalki-workbook", tool, body)

    result = asyncio.run(invoke())
    if not isinstance(result, dict) or result.get("ok") is not True:
        error = result.get("error") if isinstance(result, dict) else None
        message = error.get("message") if isinstance(error, dict) else f"{tool} failed"
        raise RuntimeError(str(message))
    data = result.get("data")
    if not isinstance(data, dict):
        raise RuntimeError(f"{tool} returned invalid data")
    return data


def _read_records(path: Path) -> list[RecordEnvelope]:
    records: list[RecordEnvelope] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        value = json.loads(line)
        provenance = value["provenance"]
        records.append(
            RecordEnvelope(
                data=value["data"],
                dedupe_key=value["dedupe_key"],
                provenance=Provenance(
                    kind=provenance["kind"],
                    source_url=provenance["source_url"],
                    retrieved_at=provenance["retrieved_at"],
                    parents=tuple(
                        ProvenanceParent(
                            table_slug=parent["table_slug"],
                            dedupe_key=parent["dedupe_key"],
                        )
                        for parent in provenance.get("parents", [])
                    ),
                    source_record_id=provenance.get("source_record_id"),
                    evidence_path=provenance.get("evidence_path"),
                    source_hash=provenance.get("source_hash"),
                ),
            )
        )
    return records


def _load_production(workspace: Path, run_id: str) -> tuple[LoadedPipeline, dict[str, object], Path, Path]:
    run_directory = workspace_path(workspace, f"runs/{run_id}")
    checkpoint_path = run_directory / "checkpoint.json"
    manifest_path = run_directory / "manifest.json"
    if not checkpoint_path.is_file():
        raise ValueError(f"production checkpoint was not found: {run_id}")
    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    if not isinstance(checkpoint, dict) or checkpoint.get("run_id") != run_id or checkpoint.get("mode") != "production":
        raise ValueError("production checkpoint does not match the run")
    pipeline_path = checkpoint.get("pipeline_path")
    if not isinstance(pipeline_path, str):
        raise ValueError("production checkpoint is missing pipeline_path")
    pipeline = load_pipeline(workspace, pipeline_path)
    hashes = checkpoint.get("hashes")
    if hashes != {
        "task": pipeline.task_hash,
        "schema": pipeline.schema_hash,
        "pipeline": pipeline.pipeline_hash,
    }:
        raise ValueError("approved files changed after production started")
    return pipeline, checkpoint, checkpoint_path, manifest_path


def _table_records(pipeline: LoadedPipeline, state: dict[str, object]) -> list[RecordEnvelope]:
    relative = state.get("path")
    sha256 = state.get("sha256")
    if not isinstance(relative, str) or not isinstance(sha256, str):
        raise ValueError("checkpoint table file is incomplete")
    path = workspace_path(pipeline.workspace, relative)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != sha256:
        raise ValueError(f"run file hash changed: {relative}")
    records = _read_records(path)
    if len(records) != state.get("count"):
        raise ValueError(f"run file count changed: {relative}")
    return records


def _publish_table_batch(
    pipeline: LoadedPipeline,
    checkpoint: dict[str, object],
    table_slug: str,
    limit: int,
) -> dict[str, object]:
    tables = checkpoint["tables"]
    if not isinstance(tables, dict) or not isinstance(tables.get(table_slug), dict):
        raise ValueError(f"checkpoint table was not found: {table_slug}")
    state = tables[table_slug]
    records = _table_records(pipeline, state)
    cursor = state.get("cursor")
    batch_index = state.get("next_batch_index")
    if not isinstance(cursor, int) or not isinstance(batch_index, int):
        raise ValueError("checkpoint cursor is invalid")
    batch = records[cursor : cursor + limit]
    if not batch:
        state["complete"] = True
        return {"published": 0, "published_total": checkpoint.get("published_total", 0), "batch_key": None}

    batch_key = f"{table_slug}:{batch_index:08d}"
    serialized = [envelope_dict(record) for record in batch]
    payload_hash = hash_json(
        {
            "run_id": checkpoint["run_id"],
            "table_slug": table_slug,
            "batch_key": batch_key,
            "records": serialized,
        }
    )
    hashes = checkpoint["hashes"]
    result = _workbook_call(
        "publish_batch",
        {
            "run_id": checkpoint["run_id"],
            "table_slug": table_slug,
            "batch_key": batch_key,
            "payload_hash": payload_hash,
            "task_hash": hashes["task"],
            "schema_hash": hashes["schema"],
            "pipeline_hash": hashes["pipeline"],
            "records": serialized,
        },
    )
    if (
        result.get("batch_key") != batch_key
        or result.get("payload_hash") != payload_hash
        or result.get("processed") != len(batch)
    ):
        raise RuntimeError("publish_batch confirmation did not match the requested batch")

    state["cursor"] = cursor + len(batch)
    state["next_batch_index"] = batch_index + 1
    state["complete"] = state["cursor"] == state["count"]
    checkpoint["published_total"] = result.get("published_row_count")
    return {
        "published": len(batch),
        "published_total": result.get("published_row_count"),
        "batch_key": batch_key,
    }


def _production_manifest(
    pipeline: LoadedPipeline,
    checkpoint: dict[str, object],
    command: str,
    *,
    published: int = 0,
    current_table: str | None = None,
    batch_key: str | None = None,
) -> dict[str, object]:
    tables = checkpoint["tables"]
    source_slug = pipeline.data["source"]["table"]
    source_count = tables[source_slug]["count"]
    derived_count = sum(
        state["count"]
        for slug, state in tables.items()
        if slug != source_slug and isinstance(state, dict)
    )
    state = checkpoint["phase"]
    return {
        "version": 1,
        "ok": True,
        "command": command,
        "run_id": checkpoint["run_id"],
        "mode": "production",
        "state": state,
        "task_hash": pipeline.task_hash,
        "schema_hash": pipeline.schema_hash,
        "pipeline_hash": pipeline.pipeline_hash,
        "counts": {
            "source_records": source_count,
            "derived_records": derived_count,
            "published_this_call": published,
            "published_total": checkpoint.get("published_total", 0),
        },
        "tables": {slug: {"count": item["count"]} for slug, item in tables.items()},
        "current_table": current_table,
        "batch_key": batch_key,
        "done": state in {"ready_to_finalize", "completed"},
        "next_action": "finalize" if state == "ready_to_finalize" else "done" if state == "completed" else "next-batch",
        "paths": {
            "manifest": f"runs/{checkpoint['run_id']}/manifest.json",
            "checkpoint": f"runs/{checkpoint['run_id']}/checkpoint.json",
        },
        "error": None,
    }


def start_production(pipeline: LoadedPipeline, run_id: str) -> dict[str, object]:
    run_directory = workspace_path(pipeline.workspace, f"runs/{run_id}")
    checkpoint_path = run_directory / "checkpoint.json"
    manifest_path = run_directory / "manifest.json"
    if checkpoint_path.exists():
        existing_pipeline, checkpoint, _, _ = _load_production(pipeline.workspace, run_id)
        if (
            existing_pipeline.relative_path != pipeline.relative_path
            or existing_pipeline.task_hash != pipeline.task_hash
            or existing_pipeline.schema_hash != pipeline.schema_hash
            or existing_pipeline.pipeline_hash != pipeline.pipeline_hash
        ):
            raise ValueError("existing production checkpoint does not match the requested pipeline")
        return _production_manifest(pipeline, checkpoint, "start-production")

    authorization = _workbook_call(
        "get_production_authorization",
        {
            "run_id": run_id,
            "task_hash": pipeline.task_hash,
            "schema_hash": pipeline.schema_hash,
            "pipeline_hash": pipeline.pipeline_hash,
        },
    )
    if authorization.get("authorized") is not True:
        raise RuntimeError(f"production is not authorized: {authorization.get('reason', 'unknown')}")
    if not isinstance(authorization.get("trueforge_turn_id"), str):
        raise RuntimeError("production authorization is missing the TrueForge turn")

    source = pipeline.data["source"]
    execution = pipeline.data["execution"]
    source_class = _load_class(pipeline.workspace, source["operator"])
    context = RunContext(
        workspace=pipeline.workspace,
        run_id=run_id,
        mode="production",
        step_id=source["id"],
        input_table=None,
        output_table=source["table"],
        config=source["config"],
        limit=None,
        http=AllowlistedHttpClient(
            allowed_hosts=set(execution["allowed_hosts"]),
            timeout=execution["request_timeout_seconds"],
            max_bytes=execution["max_response_bytes"],
        ),
    )
    source_records = _validated_records(list(source_class().collect(context)), pipeline.schemas[source["table"]])
    if not source_records:
        raise ValueError("production source returned no records")
    source_path = run_directory / "source.jsonl"
    source_sha256 = write_jsonl(source_path, source_records)

    tables: dict[str, dict[str, object]] = {
        source["table"]: {
            "kind": "source",
            "path": source_path.relative_to(pipeline.workspace).as_posix(),
            "sha256": source_sha256,
            "count": len(source_records),
            "cursor": 0,
            "next_batch_index": 0,
            "complete": False,
        }
    }
    for transform in pipeline.data["transforms"]:
        output = transform["output_table"]
        tables[output] = {
            "kind": "derived",
            "path": f"runs/{run_id}/derived/{output}.jsonl",
            "sha256": None,
            "count": 0,
            "cursor": 0,
            "next_batch_index": 0,
            "complete": False,
        }
    checkpoint: dict[str, object] = {
        "version": 1,
        "run_id": run_id,
        "mode": "production",
        "pipeline_path": pipeline.relative_path,
        "phase": "publishing_source",
        "hashes": {
            "task": pipeline.task_hash,
            "schema": pipeline.schema_hash,
            "pipeline": pipeline.pipeline_hash,
        },
        "authorization": {
            "approval_event_id": authorization.get("approval_event_id"),
            "workbook_id": authorization.get("workbook_id"),
            "task_id": authorization.get("task_id"),
            "trueforge_turn_id": authorization["trueforge_turn_id"],
        },
        "tables": tables,
        "published_total": 0,
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    write_json(checkpoint_path, checkpoint)
    manifest = _production_manifest(pipeline, checkpoint, "start-production")
    write_json(manifest_path, manifest)
    return manifest


def next_batch(workspace: Path, run_id: str, limit: int) -> dict[str, object]:
    pipeline, checkpoint, checkpoint_path, manifest_path = _load_production(workspace, run_id)
    configured_limit = min(50, pipeline.data["execution"]["publication_batch_size"])
    if not 1 <= limit <= configured_limit:
        raise ValueError(f"limit must be between 1 and {configured_limit}")
    phase = checkpoint["phase"]
    if phase == "completed" or phase == "ready_to_finalize":
        return _production_manifest(pipeline, checkpoint, "next-batch")

    current_table: str | None = None
    result = {"published": 0, "published_total": checkpoint.get("published_total", 0), "batch_key": None}
    source_slug = pipeline.data["source"]["table"]
    if phase == "publishing_source":
        current_table = source_slug
        result = _publish_table_batch(pipeline, checkpoint, current_table, limit)
        if checkpoint["tables"][current_table]["complete"]:
            checkpoint["phase"] = "transforming"
    elif phase == "transforming":
        table_records: dict[str, list[RecordEnvelope]] = {
            source_slug: _table_records(pipeline, checkpoint["tables"][source_slug])
        }
        for transform in pipeline.data["transforms"]:
            transform_class = _load_class(pipeline.workspace, transform["transformer"])
            context = RunContext(
                workspace=pipeline.workspace,
                run_id=run_id,
                mode="production",
                step_id=transform["id"],
                input_table=transform["input_table"],
                output_table=transform["output_table"],
                config=transform["config"],
                limit=None,
                http=NoNetworkHttpClient(),
            )
            records = _validated_records(
                list(transform_class().transform(iter(table_records[transform["input_table"]]), context)),
                pipeline.schemas[transform["output_table"]],
            )
            output = transform["output_table"]
            output_path = workspace_path(pipeline.workspace, checkpoint["tables"][output]["path"])
            checkpoint["tables"][output].update(
                {
                    "sha256": write_jsonl(output_path, records),
                    "count": len(records),
                    "cursor": 0,
                    "next_batch_index": 0,
                    "complete": len(records) == 0,
                }
            )
            table_records[output] = records
        checkpoint["phase"] = "publishing_derived"
        current_table = next(
            (slug for slug, state in checkpoint["tables"].items() if slug != source_slug and not state["complete"]),
            None,
        )
        if current_table:
            result = _publish_table_batch(pipeline, checkpoint, current_table, limit)
    elif phase == "publishing_derived":
        current_table = next(
            (slug for slug, state in checkpoint["tables"].items() if slug != source_slug and not state["complete"]),
            None,
        )
        if current_table:
            result = _publish_table_batch(pipeline, checkpoint, current_table, limit)
    else:
        raise ValueError(f"unsupported production phase: {phase}")

    if checkpoint["phase"] == "publishing_derived" and all(
        state["complete"] for state in checkpoint["tables"].values()
    ):
        checkpoint["phase"] = "ready_to_finalize"
    checkpoint["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    write_json(checkpoint_path, checkpoint)
    manifest = _production_manifest(
        pipeline,
        checkpoint,
        "next-batch",
        published=result["published"],
        current_table=current_table,
        batch_key=result["batch_key"],
    )
    write_json(manifest_path, manifest)
    return manifest


def _csv_value(value: object) -> object:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def _csv_artifact(schema: dict[str, object], records: list[RecordEnvelope], run_id: str) -> str:
    columns = [column["name"] for column in schema["columns"]]
    fields = [*columns, "_dedupe_key", "_source_url", "_retrieved_at", "_source_record_id", "_run_id"]
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    for record in records:
        row = {
            **record.data,
            "_dedupe_key": record.dedupe_key,
            "_source_url": record.provenance.source_url,
            "_retrieved_at": record.provenance.retrieved_at,
            "_source_record_id": record.provenance.source_record_id or "",
            "_run_id": run_id,
        }
        writer.writerow({field: _csv_value(value) for field, value in row.items()})
    return output.getvalue()


def _scan_text(value: str) -> dict[str, object]:
    markers = ("BEGIN PRIVATE KEY", "Authorization: Bearer ", "AKIA", "sk-")
    if any(marker in value for marker in markers):
        raise ValueError("artifact secret scan failed")
    return {"status": "passed", "scanner_version": 1}


def finalize_production(workspace: Path, run_id: str) -> dict[str, object]:
    pipeline, checkpoint, checkpoint_path, manifest_path = _load_production(workspace, run_id)
    if checkpoint["phase"] == "completed":
        return _production_manifest(pipeline, checkpoint, "finalize")
    if checkpoint["phase"] != "ready_to_finalize":
        raise ValueError("production run is not ready to finalize")

    table_records: dict[str, list[RecordEnvelope]] = {}
    for slug, state in checkpoint["tables"].items():
        records = _table_records(pipeline, state)
        if state["cursor"] != len(records) or not state["complete"]:
            raise ValueError(f"table is not fully published: {slug}")
        table_records[slug] = records

    artifact_directory = workspace_path(pipeline.workspace, f"artifacts/{run_id}")
    artifacts: list[dict[str, object]] = []
    for slug, records in table_records.items():
        relative = f"artifacts/{run_id}/{slug}.csv"
        content = _csv_artifact(pipeline.schemas[slug], records, run_id)
        scan = _scan_text(content)
        sha256 = write_text(workspace_path(pipeline.workspace, relative), content)
        artifacts.append(
            {
                "kind": "csv",
                "path": relative,
                "sha256": sha256,
                "size_bytes": len(content.encode("utf-8")),
                "mime_type": "text/csv",
                "metadata": {"table_slug": slug, "scan": scan},
            }
        )

    lineage = {
        "version": 1,
        "run_id": run_id,
        "tables": {
            slug: [
                {"dedupe_key": record.dedupe_key, "provenance": envelope_dict(record)["provenance"]}
                for record in records
            ]
            for slug, records in table_records.items()
        },
    }
    lineage_text = f"{canonical_json(lineage)}\n"
    lineage_path = artifact_directory / "lineage.json"
    lineage_scan = _scan_text(lineage_text)
    artifacts.append(
        {
            "kind": "lineage",
            "path": lineage_path.relative_to(pipeline.workspace).as_posix(),
            "sha256": write_text(lineage_path, lineage_text),
            "size_bytes": len(lineage_text.encode("utf-8")),
            "mime_type": "application/json",
            "metadata": {"scan": lineage_scan},
        }
    )
    report = "\n".join(
        [
            "# Kalki Run Report",
            "",
            f"Run: `{run_id}`",
            f"Source rows: {checkpoint['tables'][pipeline.data['source']['table']]['count']}",
            f"Derived rows: {sum(state['count'] for slug, state in checkpoint['tables'].items() if slug != pipeline.data['source']['table'])}",
            f"Task hash: `{pipeline.task_hash}`",
            f"Schema hash: `{pipeline.schema_hash}`",
            f"Pipeline hash: `{pipeline.pipeline_hash}`",
            "",
        ]
    )
    report_path = artifact_directory / "run-report.md"
    report_scan = _scan_text(report)
    artifacts.append(
        {
            "kind": "report",
            "path": report_path.relative_to(pipeline.workspace).as_posix(),
            "sha256": write_text(report_path, report),
            "size_bytes": len(report.encode("utf-8")),
            "mime_type": "text/markdown",
            "metadata": {"scan": report_scan},
        }
    )

    hashes = checkpoint["hashes"]
    authorization = checkpoint["authorization"]
    for artifact in artifacts:
        _workbook_call(
            "record_artifact",
            {
                "run_id": run_id,
                "trueforge_turn_id": authorization["trueforge_turn_id"],
                **artifact,
                "task_hash": hashes["task"],
                "schema_hash": hashes["schema"],
                "pipeline_hash": hashes["pipeline"],
            },
        )

    manifest = _production_manifest(pipeline, checkpoint, "finalize")
    manifest["state"] = "ready_to_finalize"
    manifest["done"] = True
    table_counts = {slug: state["count"] for slug, state in checkpoint["tables"].items()}
    completion = _workbook_call(
        "complete_run",
        {
            "run_id": run_id,
            "outcome": "completed",
            "task_hash": hashes["task"],
            "schema_hash": hashes["schema"],
            "pipeline_hash": hashes["pipeline"],
            "manifest": manifest,
            "samples": {},
            "table_counts": table_counts,
            "error": None,
        },
    )
    if completion.get("status") != "completed":
        raise RuntimeError("complete_run did not finish production")

    checkpoint["phase"] = "completed"
    checkpoint["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    write_json(checkpoint_path, checkpoint)
    final_manifest = _production_manifest(pipeline, checkpoint, "finalize")
    write_json(manifest_path, final_manifest)
    return final_manifest
