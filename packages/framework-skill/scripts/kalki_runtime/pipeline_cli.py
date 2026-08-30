import argparse
import json
import os
import sys
from pathlib import Path

from .pipeline_spec import load_pipeline
from .runner import run_test


def _workspace(value: str | None) -> Path:
    return Path(value or os.environ.get("KALKI_WORKSPACE_DIR") or Path.cwd()).resolve()


def _print(value: dict[str, object]) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m kalki_runtime.pipeline_cli")
    commands = parser.add_subparsers(dest="command", required=True)

    lint = commands.add_parser("lint")
    lint.add_argument("--pipeline", required=True)
    lint.add_argument("--workspace")

    test = commands.add_parser("test")
    test.add_argument("--pipeline", required=True)
    test.add_argument("--workspace")
    test.add_argument("--run-id")
    test.add_argument("--limit", type=int)

    args = parser.parse_args(argv)
    try:
        pipeline = load_pipeline(_workspace(args.workspace), args.pipeline)
        if args.command == "lint":
            _print(
                {
                    "version": 1,
                    "ok": True,
                    "command": "lint",
                    "state": "valid",
                    "task_hash": pipeline.task_hash,
                    "schema_hash": pipeline.schema_hash,
                    "pipeline_hash": pipeline.pipeline_hash,
                    "error": None,
                }
            )
            return 0

        run_id = args.run_id or os.environ.get("KALKI_RUN_ID")
        if not run_id or "/" in run_id or "\\" in run_id:
            raise ValueError("test requires a safe --run-id or KALKI_RUN_ID")
        configured_limit = pipeline.data["execution"]["test_limit"]
        limit = args.limit if args.limit is not None else configured_limit
        if not 1 <= limit <= configured_limit:
            raise ValueError(f"limit must be between 1 and {configured_limit}")
        _print(run_test(pipeline, run_id, limit))
        return 0
    except Exception as error:
        _print(
            {
                "version": 1,
                "ok": False,
                "command": args.command,
                "state": "failed",
                "error": {"code": "pipeline_failed", "message": str(error), "retryable": False},
            }
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
