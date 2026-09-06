import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping


def unwrap_mcp_text(raw_output: Any) -> str:
    """Normalizes any Playwright MCP result representation into a clean, unwrapped string.
    
    Handles:
    - TextContent objects from mcp-client SDK
    - Lists of TextContent or dicts
    - Python repr strings (e.g. `type='text' text='...'`)
    - Markdown tool prefixes (`### Result\\n`, `### Page\\n`)
    - JSON-escaped string content
    """
    if raw_output is None:
        return ""

    # 1. If output is already a list of objects / dicts
    if isinstance(raw_output, list):
        parts = []
        for item in raw_output:
            if hasattr(item, "text"):
                parts.append(str(item.text))
            elif isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
            else:
                parts.append(str(item))
        text = "\n".join(parts)
    elif hasattr(raw_output, "text"):
        text = str(raw_output.text)
    elif isinstance(raw_output, dict) and "text" in raw_output:
        text = str(raw_output["text"])
    else:
        text = str(raw_output)

    # 2. If it's a python repr string dumped from CLI stdout: e.g. text='### Result\n...'
    repr_match = re.search(r"text=(['\"])(.*?)\1", text, flags=re.DOTALL)
    if repr_match:
        raw_inner = repr_match.group(2)
        try:
            text = raw_inner.encode("utf-8").decode("unicode_escape")
        except Exception:
            text = raw_inner

    # 3. Strip standard MCP Markdown headings emitted by Playwright tool wrapper
    text = re.sub(r"^###\s+Result\s*\n?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^###\s+Page\s*\n?", "", text, flags=re.IGNORECASE)

    # 4. If string still contains literal escaped quotes or escaped newlines, decode them
    if '\\"' in text or '\\n' in text:
        try:
            text = text.encode("utf-8").decode("unicode_escape")
        except Exception:
            pass

    return text.strip()


def call_playwright_tool(tool_name: str, arguments: Mapping[str, Any] | None = None) -> str:
    """Executes a Playwright MCP tool through the available client or CLI and returns normalized text."""
    args = arguments or {}

    # Attempt direct import if mcp-client package is on disk
    mcp_dir = Path("/opt/tf/mcp-client")
    if mcp_dir.exists() and str(mcp_dir) not in sys.path:
        sys.path.insert(0, str(mcp_dir))

    try:
        from mcp_client import call_tool_sync  # type: ignore
        result = call_tool_sync("playwright", tool_name, args)
        return unwrap_mcp_text(result)
    except Exception:
        pass

    # Fallback to subprocess invocation via CLI
    cli_candidates = [
        Path("/opt/tf/mcp-client/mcp_client.py"),
        Path(__file__).resolve().parent.parent / "mcp_client.py",
        Path("mcp_client.py")
    ]
    cli_path = next((str(p) for p in cli_candidates if p.exists()), "/opt/tf/mcp-client/mcp_client.py")

    cmd = [sys.executable, cli_path, "call-tool", "playwright", tool_name, json.dumps(args)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        err_msg = proc.stderr.strip() or proc.stdout.strip()
        raise RuntimeError(f"Playwright tool '{tool_name}' failed with code {proc.returncode}: {err_msg}")

    return unwrap_mcp_text(proc.stdout)


class BrowserAcquisitionClient:
    """Safe browser acquisition client providing bounded, normalized data extraction for operators."""

    def __init__(self, max_response_bytes: int = 10 * 1024 * 1024):
        self.max_response_bytes = max_response_bytes

    def fetch_network_requests(self, filter_term: str | None = None) -> list[dict[str, Any]]:
        """Lists captured non-static network requests."""
        args: dict[str, Any] = {"static": False}
        if filter_term:
            args["filter"] = filter_term
        raw = call_playwright_tool("browser_network_requests", args)
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass

        # Parse text lines format: '255. [POST] https://...'
        requests = []
        for line in raw.split("\n"):
            line = line.strip()
            if not line:
                continue
            m = re.match(r"^(\d+)\.\s+\[(\w+)\]\s+(https?://\S+)", line)
            if m:
                requests.append({
                    "index": int(m.group(1)),
                    "method": m.group(2),
                    "url": m.group(3)
                })
        return requests

    def fetch_text(self, request_index: int, part: str = "response") -> str:
        """Fetches normalized text content of a captured network request or response."""
        raw = call_playwright_tool("browser_network_request", {"index": request_index, "part": part})
        body_bytes = raw.encode("utf-8")
        if len(body_bytes) > self.max_response_bytes:
            raise ValueError(f"Browser response {request_index} exceeded max_response_bytes ({len(body_bytes)} > {self.max_response_bytes})")
        return raw

    def fetch_json(self, request_index: int, part: str = "response") -> Any:
        """Fetches and parses JSON from a captured network request or response with strict=False."""
        text = self.fetch_text(request_index, part=part)
        try:
            return json.loads(text, strict=False)
        except json.JSONDecodeError as exc:
            # If the response contains an embedded JSON object within text, attempt regex boundary parse
            match = re.search(r"(\{.*\}|\[.*\])", text, flags=re.DOTALL)
            if match:
                return json.loads(match.group(1), strict=False)
            raise ValueError(f"Failed to decode JSON from network request {request_index}: {exc}") from exc

    def fetch_page_snapshot(self, depth: int = 5) -> str:
        """Fetches bounded accessibility snapshot of the current page."""
        return call_playwright_tool("browser_snapshot", {"depth": depth})

    def fetch_research_json(self, relative_path: str | Path) -> Any:
        """Reads pre-saved research evidence JSON (e.g. research/founders.json) without network overhead."""
        p = Path(relative_path)
        if not p.exists():
            raise FileNotFoundError(f"Research artifact not found: {p}")
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f, strict=False)
