import argparse
import json
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--workbook-id", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--example", default="tesla")
    args = parser.parse_args()

    skill_root = Path(__file__).resolve().parents[1]
    example = skill_root / "examples" / args.example
    workspace = Path(args.workspace).resolve()
    if not example.is_dir():
        raise SystemExit(f"unknown example: {args.example}")

    workspace.mkdir(parents=True, exist_ok=True)
    shutil.copytree(example, workspace, dirs_exist_ok=True)
    shutil.copytree(
        Path(__file__).parent / "kalki_runtime",
        workspace / "kalki_runtime",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    metadata = workspace / ".kalki"
    metadata.mkdir(exist_ok=True)
    (metadata / "workspace.json").write_text(
        json.dumps({"version": 1, "workbook_id": args.workbook_id, "task_id": args.task_id}, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
    )
    (workspace / "AGENTS.md").write_text(
        "# Kalki Task Workspace\n\nUse the mounted kalki-framework skill and keep full records in workspace files.\n",
        encoding="utf-8",
    )
    (workspace / "CLAUDE.md").write_text("@AGENTS.md\n", encoding="utf-8")
    print(json.dumps({"ok": True, "workspace": str(workspace), "example": args.example}, separators=(",", ":")))


if __name__ == "__main__":
    main()
