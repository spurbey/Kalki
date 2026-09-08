import asyncio
import base64
import gzip
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping


def _safe_unescape_text(s: str) -> str:
    r"""Safely decodes standard string escape sequences (\", \', \\, \n, \r, \t, \uXXXX)
    without corrupting existing UTF-8 characters like 'José'.
    """
    if not s or "\\" not in s:
        return s

    # 1. Unescape \uXXXX unicode escapes
    def replace_unicode(m: re.Match[str]) -> str:
        try:
            return chr(int(m.group(1), 16))
        except ValueError:
            return m.group(0)

    s = re.sub(r"\\u([0-9a-fA-F]{4})", replace_unicode, s)

    # 2. Unescape standard control and quote escapes
    escape_map = {
        '\\"': '"',
        "\\'": "'",
        "\\\\": "\\",
        "\\n": "\n",
        "\\r": "\r",
        "\\t": "\t",
        "\\b": "\b",
        "\\f": "\f",
    }
    for esc, repl in escape_map.items():
        if esc in s:
            s = s.replace(esc, repl)
    return s


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
        text = _safe_unescape_text(repr_match.group(2))

    # 3. Strip standard MCP Markdown headings emitted by Playwright tool wrapper
    text = re.sub(r"^###\s+Result\s*\n?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^###\s+Page\s*\n?", "", text, flags=re.IGNORECASE)

    # 4. If string still contains literal escaped quotes or escaped newlines, safely unescape them
    text = _safe_unescape_text(text)

    return text.strip()


def call_mcp_tool(
    server: str,
    tool_name: str,
    arguments: Mapping[str, Any] | None = None,
) -> Any:
    """Calls an MCP tool through Code Mode and returns its projected value."""
    args = arguments or {}

    # Attempt direct in-process call if mcp-client package is on disk
    mcp_dir = Path("/opt/tf/mcp-client")
    if mcp_dir.exists() and str(mcp_dir) not in sys.path:
        sys.path.insert(0, str(mcp_dir))

    try:
        from mcp_client import call_tool  # type: ignore
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                result = executor.submit(asyncio.run, call_tool(server, tool_name, args)).result()
        else:
            result = asyncio.run(call_tool(server, tool_name, args))
        return result
    except (ImportError, ModuleNotFoundError):
        pass

    # Fallback to subprocess invocation via CLI
    cli_candidates = [
        Path("/opt/tf/mcp-client/mcp_client.py"),
        Path(__file__).resolve().parent.parent / "mcp_client.py",
        Path("mcp_client.py")
    ]
    cli_path = next((str(p) for p in cli_candidates if p.exists()), "/opt/tf/mcp-client/mcp_client.py")

    cmd = [sys.executable, cli_path, "call-tool", server, tool_name, json.dumps(args)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        err_msg = proc.stderr.strip() or proc.stdout.strip()
        raise RuntimeError(f"MCP tool '{server}/{tool_name}' failed with code {proc.returncode}: {err_msg}")

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.stdout


def call_playwright_tool(tool_name: str, arguments: Mapping[str, Any] | None = None) -> str:
    """Executes a Playwright MCP tool and returns normalized text."""
    return unwrap_mcp_text(call_mcp_tool("playwright", tool_name, arguments))


class BrowserAcquisitionClient:
    """Safe browser acquisition client providing bounded, normalized data extraction for operators."""

    def __init__(self, workspace: Path | str | None = None, max_response_bytes: int = 10 * 1024 * 1024):
        self.workspace = Path(workspace).resolve() if workspace else Path.cwd().resolve()
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
            if isinstance(parsed, dict) and isinstance(parsed.get("requests"), list):
                return parsed["requests"]
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

    def fetch_pages(
        self,
        urls: list[str],
        max_chars: int = 80_000,
    ) -> list[dict[str, Any]]:
        """Fetches a small batch of pages through the current shared browser tab."""
        if not 1 <= len(urls) <= 5:
            raise ValueError("fetch_pages accepts between 1 and 5 URLs")
        if not 10_000 <= max_chars <= 120_000:
            raise ValueError("max_chars must be between 10000 and 120000")

        result = call_mcp_tool(
            "kalki-workbook",
            "browser_fetch_pages",
            {"urls": urls, "max_chars": max_chars},
        )
        if not isinstance(result, dict) or result.get("ok") is not True:
            error = result.get("error") if isinstance(result, dict) else result
            raise RuntimeError(f"browser_fetch_pages failed: {error}")
        data = result.get("data")
        pages = data.get("pages") if isinstance(data, dict) else None
        if not isinstance(pages, list) or not 1 <= len(pages) <= 5:
            raise RuntimeError("browser_fetch_pages returned an invalid page list")
        normalized = []
        for page in pages:
            if not isinstance(page, dict):
                raise RuntimeError("browser_fetch_pages returned an invalid page")
            encoded = page.get("body_base64")
            if encoded is not None:
                if page.get("body_encoding") != "gzip+base64":
                    raise RuntimeError("browser_fetch_pages returned an unknown body encoding")
                try:
                    body = gzip.decompress(base64.b64decode(encoded, validate=True)).decode("utf-8")
                except (ValueError, OSError, UnicodeDecodeError) as exc:
                    raise RuntimeError(f"browser_fetch_pages returned an invalid body: {exc}") from exc
            else:
                body = None
            clean_page = {
                key: value
                for key, value in page.items()
                if key not in {"body_base64", "body_encoding"}
            }
            clean_page["body"] = body
            normalized.append(clean_page)
        return normalized

    def fetch_page_snapshot(self, depth: int = 5) -> str:
        """Fetches bounded accessibility snapshot of the current page."""
        return call_playwright_tool("browser_snapshot", {"depth": depth})

    def fetch_research_json(self, relative_path: str | Path) -> Any:
        """Reads pre-saved research evidence JSON without network overhead, confined to the workspace."""
        path = Path(relative_path)
        if path.is_absolute():
            resolved = path.resolve()
        else:
            resolved = (self.workspace / path).resolve()

        if not resolved.is_relative_to(self.workspace):
            raise ValueError(f"Research path escapes workspace: {relative_path}")

        if not resolved.exists():
            raise FileNotFoundError(f"Research artifact not found: {resolved}")

        with open(resolved, "r", encoding="utf-8") as f:
            return json.load(f, strict=False)
