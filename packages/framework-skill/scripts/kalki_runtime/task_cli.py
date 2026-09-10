import argparse
import json
import os
import sys
from pathlib import Path

from .browser import call_mcp_tool
from .pipeline_spec import workspace_path


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


def _register(workspace: Path, task_id: str, relative_path: str) -> dict[str, object]:
    path = workspace_path(workspace, relative_path)
    if not path.is_file():
        raise ValueError(f"task file does not exist: {relative_path}")
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    if len(text.encode("utf-8")) > 65_536:
        raise ValueError("task.md exceeds the 64 KiB limit")
    result = call_mcp_tool(
        "kalki-workbook",
        "register_task",
        {
            "task_id": task_id,
            "task_path": relative_path,
            "task_markdown": text,
        },
    )
    if not isinstance(result, dict) or result.get("ok") is not True:
        error = result.get("error") if isinstance(result, dict) else result
        raise RuntimeError(f"register_task failed: {error}")
    data = result.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("register_task returned invalid data")
    return {
        "version": 1,
        "ok": True,
        "command": "register-task",
        "task_path": relative_path,
        "registration": data,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m kalki_runtime.task_cli")
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("register")
    register.add_argument("--workspace")
    register.add_argument("--task-id")
    register.add_argument("--task-path", default="task.md")
    args = parser.parse_args(argv)

    try:
        workspace = _workspace(args.workspace)
        if args.command != "register":
            raise ValueError(f"unsupported command: {args.command}")
        result = _register(workspace, _task_id(workspace, args.task_id), args.task_path)
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
                    "error": {"code": "task_registration_failed", "message": str(error)},
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
