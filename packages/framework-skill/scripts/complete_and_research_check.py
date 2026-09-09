import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from kalki_runtime.contracts import RecordEnvelope
from kalki_runtime.pipeline_spec import hash_json
from kalki_runtime.provenance import Provenance
from kalki_runtime.research_cli import capture
from kalki_runtime.runner import complete_test
from kalki_runtime.serialization import envelope_dict, write_json, write_jsonl


def test_complete_test() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        workspace = Path(tmpdir)
        run_id = "run_eval_test_001"
        run_dir = workspace / "runs" / run_id
        run_dir.mkdir(parents=True)

        source_path = run_dir / "source.jsonl"
        manifest_path = run_dir / "manifest.json"

        # Create 5 sample records
        records = []
        for i in range(1, 6):
            records.append(
                RecordEnvelope(
                    data={"id": f"item_{i}", "title": f"Test Story {i}", "score": i * 10},
                    dedupe_key=f"item_{i}",
                    provenance=Provenance(
                        kind="direct",
                        source_url="https://example.com/items",
                        retrieved_at="2026-09-09T00:00:00+00:00",
                        source_record_id=f"item_{i}",
                    ),
                )
            )
        source_sha256 = write_jsonl(source_path, records)

        manifest = {
            "version": 1,
            "ok": True,
            "command": "test",
            "run_id": run_id,
            "mode": "test",
            "state": "ready_to_finalize",
            "task_hash": "a" * 64,
            "schema_hash": "b" * 64,
            "pipeline_hash": "c" * 64,
            "counts": {"source_records": 5, "derived_records": 0},
            "tables": {
                "items": {
                    "path": f"runs/{run_id}/source.jsonl",
                    "sha256": source_sha256,
                    "count": 5,
                }
            },
            "done": True,
            "next_action": "review_test",
            "error": None,
        }
        write_json(manifest_path, manifest)

        mock_mcp_response = {
            "ok": True,
            "data": {
                "run_id": run_id,
                "mode": "test",
                "status": "completed",
                "task_state": "awaiting_production_confirmation",
                "counts": {},
                "next_action": "ask_production_review",
            },
        }

        with patch("kalki_runtime.runner.call_mcp_tool", return_value=mock_mcp_response) as mock_call:
            result = complete_test(workspace, run_id)
            assert result["ok"] is True
            assert result["command"] == "complete"
            assert result["status"] == "completed"
            assert result["task_state"] == "awaiting_production_confirmation"

            # Verify call payload
            mock_call.assert_called_once()
            server, tool_name, payload = mock_call.call_args[0]
            assert server == "kalki-workbook"
            assert tool_name == "complete_run"
            assert payload["run_id"] == run_id
            assert payload["outcome"] == "completed"
            assert payload["table_counts"] == {}  # Strictly empty in test mode!
            assert payload["task_hash"] == "a" * 64
            assert "items" in payload["samples"]
            assert len(payload["samples"]["items"]) == 5
            assert payload["samples"]["items"][0]["dedupe_key"] == "item_1"


def test_research_capture() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        workspace = Path(tmpdir)
        mock_pages = [
            {
                "url": "https://news.ycombinator.com/news",
                "status": 200,
                "body": "<html><body><h1>Hacker News</h1></body></html>",
            }
        ]
        with patch("kalki_runtime.browser.BrowserAcquisitionClient.fetch_pages", return_value=mock_pages):
            result = capture(workspace, "https://news.ycombinator.com/news", "research/captures/hn.html")
            assert result["ok"] is True
            assert result["command"] == "capture"
            assert result["bytes"] > 0
            assert (workspace / "research" / "captures" / "hn.html").is_file()
            assert "Hacker News" in (workspace / "research" / "captures" / "hn.html").read_text(encoding="utf-8")


def main() -> None:
    test_complete_test()
    test_research_capture()
    print("COMPLETE_AND_RESEARCH_CHECK_OK")


if __name__ == "__main__":
    main()
