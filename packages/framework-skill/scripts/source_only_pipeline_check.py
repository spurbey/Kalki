from pathlib import Path
from tempfile import TemporaryDirectory

import yaml

from kalki_runtime.pipeline_spec import load_pipeline


def main() -> None:
    with TemporaryDirectory() as directory:
        workspace = Path(directory)
        (workspace / "task.md").write_text("# Source-only task\n", encoding="utf-8")
        (workspace / "schema.yaml").write_text(
            yaml.safe_dump(
                {
                    "version": 1,
                    "table": {
                        "slug": "items",
                        "name": "Items",
                        "kind": "source",
                        "description": "Collected items.",
                        "primary_key": ["id"],
                    },
                    "columns": [
                        {
                            "name": "id",
                            "type": "string",
                            "nullable": False,
                            "description": "Stable item id.",
                        }
                    ],
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        (workspace / "source.py").write_text(
            "class ItemsSource:\n    def collect(self, context):\n        return iter(())\n",
            encoding="utf-8",
        )
        (workspace / "pipeline.yaml").write_text(
            yaml.safe_dump(
                {
                    "version": 1,
                    "pipeline": {
                        "slug": "items",
                        "name": "Items",
                        "task_path": "task.md",
                        "support_paths": [],
                    },
                    "source": {
                        "id": "collect-items",
                        "table": "items",
                        "schema_path": "schema.yaml",
                        "operator": "source.py:ItemsSource",
                        "config": {},
                    },
                    "transforms": [],
                    "execution": {
                        "test_limit": 5,
                        "publication_batch_size": 50,
                        "request_timeout_seconds": 20,
                        "request_max_attempts": 2,
                        "request_backoff_seconds": 1,
                        "max_response_bytes": 1000000,
                        "allowed_hosts": ["example.com"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )

        pipeline = load_pipeline(workspace, "pipeline.yaml")
        if pipeline.data["transforms"] != []:
            raise SystemExit("source-only transforms were not preserved")

    print("SOURCE_ONLY_PIPELINE_OK")


if __name__ == "__main__":
    main()
