import argparse
import json
import os
import sys
from pathlib import Path

from .browser import call_mcp_tool
from .pipeline_spec import workspace_path
from .schema_loader import aggregate_schema_hash, load_schema, schema_hash


def _workspace(value: str | None) -> Path:
    return Path(value or os.environ.get("KALKI_WORKSPACE_DIR") or Path.cwd()).resolve()


def _task_id(workspace: Path, value: str | None) -> str:
    if value:
        return value
    metadata_path = workspace / ".kalki" / "workspace.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("pass --task-id or provide .kalki/workspace.json") from error
    task_id = metadata.get("task_id") if isinstance(metadata, dict) else None
    if not isinstance(task_id, str) or not task_id:
        raise ValueError(".kalki/workspace.json has no task_id")
    return task_id


def _schema_payload(workspace: Path, task_id: str) -> tuple[dict[str, object], int, str]:
    schema_root = workspace / "schemas"
    paths = sorted(
        [*schema_root.rglob("*.yaml"), *schema_root.rglob("*.yml")],
        key=lambda path: path.relative_to(workspace).as_posix(),
    )
    if not paths:
        raise ValueError("no schema YAML files found under schemas/")

    registrations: list[dict[str, object]] = []
    entries: list[tuple[str, str]] = []
    for path in paths:
        relative = path.relative_to(workspace).as_posix()
        schema = load_schema(workspace_path(workspace, relative))
        table = schema.get("table") if isinstance(schema, dict) else None
        slug = table.get("slug") if isinstance(table, dict) else None
        expected = f"schemas/{slug}.yaml"
        if relative != expected:
            raise ValueError(
                f"Schema file '{relative}' does not match table slug '{slug}'. "
                f"Schema file must be named '{expected}'"
            )
        digest = schema_hash(schema)
        registrations.append({"path": relative, "schema": schema, "schema_hash": digest})
        entries.append((relative, digest))

    aggregate = aggregate_schema_hash(entries)
    return {
        "task_id": task_id,
        "schemas": registrations,
        "aggregate_schema_hash": aggregate,
    }, len(registrations), aggregate


def _register(workspace: Path, task_id: str) -> dict[str, object]:
    payload, count, aggregate = _schema_payload(workspace, task_id)
    result = call_mcp_tool("kalki-workbook", "register_schema", payload)
    if not isinstance(result, dict) or result.get("ok") is not True:
        error = result.get("error") if isinstance(result, dict) else result
        raise RuntimeError(f"register_schema failed: {error}")
    data = result.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("register_schema returned invalid data")
    return {
        "version": 1,
        "ok": True,
        "command": "register-schema",
        "schema_count": count,
        "aggregate_schema_hash": aggregate,
        "registration": data,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m kalki_runtime.schema_cli")
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("register")
    register.add_argument("--workspace")
    register.add_argument("--task-id")
    args = parser.parse_args(argv)

    try:
        workspace = _workspace(args.workspace)
        if args.command != "register":
            raise ValueError(f"unsupported command: {args.command}")
        result = _register(workspace, _task_id(workspace, args.task_id))
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "version": 1,
                    "ok": False,
                    "command": args.command,
                    "state": "failed",
                    "error": {"code": "schema_registration_failed", "message": str(error)},
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
