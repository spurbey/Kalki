import argparse
import json
import os
import sys
from pathlib import Path

from .browser import BrowserAcquisitionClient
from .pipeline_spec import workspace_path


def _workspace(value: str | None) -> Path:
    return Path(value or os.environ.get("KALKI_WORKSPACE_DIR") or Path.cwd()).resolve()


def capture(workspace: Path, url: str, out_path: str, max_chars: int = 80_000) -> dict[str, object]:
    client = BrowserAcquisitionClient(workspace=workspace)
    pages = client.fetch_pages([url], max_chars=max_chars)
    if not pages or not pages[0].get("body"):
        error_msg = pages[0].get("error") if pages else "no pages returned"
        raise RuntimeError(f"failed to fetch body for {url}: {error_msg}")

    body = pages[0]["body"]
    dest = workspace_path(workspace, out_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(body, encoding="utf-8")

    return {
        "version": 1,
        "ok": True,
        "command": "capture",
        "url": url,
        "path": dest.relative_to(workspace).as_posix(),
        "bytes": len(body.encode("utf-8")),
        "chars": len(body),
        "status": pages[0].get("status", 200),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m kalki_runtime.research_cli")
    commands = parser.add_subparsers(dest="command", required=True)

    cap = commands.add_parser("capture")
    cap.add_argument("--url", required=True)
    cap.add_argument("--out", required=True)
    cap.add_argument("--max-chars", type=int, default=80_000)
    cap.add_argument("--workspace")

    args = parser.parse_args(argv)
    try:
        workspace = _workspace(args.workspace)
        if args.command != "capture":
            raise ValueError(f"unsupported command: {args.command}")
        result = capture(workspace, args.url, args.out, args.max_chars)
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
                    "error": {"code": "research_capture_failed", "message": str(error)},
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
