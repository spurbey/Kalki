import argparse
import json
import os
import re
import sys
from pathlib import Path

from .pipeline_spec import load_pipeline
from .runner import finalize_production, next_batch, run_test, start_production


def _workspace(value: str | None) -> Path:
    return Path(value or os.environ.get("KALKI_WORKSPACE_DIR") or Path.cwd()).resolve()


def _print(value: dict[str, object]) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def _run_id(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value) is None:
        raise ValueError("run id must start with a letter or number and contain only letters, numbers, '_' or '-'")
    return value


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

    production = commands.add_parser("start-production")
    production.add_argument("--pipeline", required=True)
    production.add_argument("--workspace")
    production.add_argument("--run-id", required=True)

    batch = commands.add_parser("next-batch")
    batch.add_argument("--workspace")
    batch.add_argument("--run-id", required=True)
    batch.add_argument("--limit", type=int, default=50)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--workspace")
    finalize.add_argument("--run-id", required=True)

    args = parser.parse_args(argv)
    try:
        workspace = _workspace(args.workspace)
        if args.command == "next-batch":
            _print(next_batch(workspace, _run_id(args.run_id), args.limit))
            return 0
        if args.command == "finalize":
            _print(finalize_production(workspace, _run_id(args.run_id)))
            return 0

        pipeline = load_pipeline(workspace, args.pipeline)
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

        if args.command == "start-production":
            _print(start_production(pipeline, _run_id(args.run_id)))
            return 0

        run_id = _run_id(args.run_id or os.environ.get("KALKI_RUN_ID"))
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
