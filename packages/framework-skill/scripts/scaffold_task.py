import argparse
import json
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--workbook-id", required=True)
    parser.add_argument("--task-id", required=True)
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    for relative in ("research", "schemas", "generated/models", "operators", "pipelines", "runs", "artifacts"):
        (workspace / relative).mkdir(parents=True, exist_ok=True)
    task_path = workspace / "task.md"
    if not task_path.exists():
        task_path.write_text("# Task\n\n", encoding="utf-8")
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
        "# Kalki Task Workspace\n\n"
        "Read the mounted kalki-framework skill before editing workflow files.\n"
        "Generate source code from recorded research evidence, use the current working directory, "
        "and keep full records under runs/.\n",
        encoding="utf-8",
    )
    (workspace / "CLAUDE.md").write_text("@AGENTS.md\n", encoding="utf-8")
    print(json.dumps({"ok": True, "workspace": str(workspace)}, separators=(",", ":")))


if __name__ == "__main__":
    main()
