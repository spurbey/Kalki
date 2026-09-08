import json
import tempfile
from pathlib import Path

from kalki_runtime.browser import BrowserAcquisitionClient, unwrap_mcp_text


class MockTextContent:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text


def test_unwrap_mcp_text() -> None:
    # 1. Plain text with Markdown prefix
    res1 = unwrap_mcp_text("### Result\n{\"status\": \"ok\"}")
    assert res1 == '{"status": "ok"}', f"Expected stripped markdown, got {res1}"

    # 2. TextContent object
    mock_obj = MockTextContent("### Result\n{\"id\": 123}")
    res2 = unwrap_mcp_text(mock_obj)
    assert res2 == '{"id": 123}', f"Expected extracted TextContent, got {res2}"

    # 3. List of TextContent objects
    mock_list = [MockTextContent("line 1"), MockTextContent("line 2")]
    res3 = unwrap_mcp_text(mock_list)
    assert res3 == "line 1\nline 2", f"Expected joined list, got {res3}"

    # 4. Python repr string from CLI stdout
    repr_str = "exit=0\n[\"type='text' text='### Result\\\\n{\\\\\\\"hits\\\\\\\":[1,2,3]}'\" type='text']"
    res4 = unwrap_mcp_text(repr_str)
    assert '{"hits":[1,2,3]}' in res4, f"Expected unescaped json inside repr, got {res4}"

    # 5. Dict with text
    dict_obj = {"type": "text", "text": "### Page\n<html><body>Test</body></html>"}
    res5 = unwrap_mcp_text(dict_obj)
    assert res5 == "<html><body>Test</body></html>", f"Expected unwrapped dict text, got {res5}"


def test_unicode_preservation() -> None:
    # Test that UTF-8 multi-byte characters (accents, umlauts, CJK, emoji) are preserved
    test_cases = [
        ("José Founder", "José Founder"),
        ("### Result\nFounder: André & Björn", "Founder: André & Björn"),
        ("type='text' text='CEO: José Silva\\nLocation: São Paulo'", "CEO: José Silva\nLocation: São Paulo"),
        ("{\"name\": \"José\", \"title\": \"Co-founder \\u0026 CEO\"}", "{\"name\": \"José\", \"title\": \"Co-founder & CEO\"}"),
    ]
    for raw, expected in test_cases:
        res = unwrap_mcp_text(raw)
        assert res == expected, f"Unicode corruption detected! Expected '{expected}', got '{res}'"


def test_fetch_research_json() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        workspace = Path(tmpdir) / "workspace"
        workspace.mkdir()
        json_file = workspace / "research" / "test.json"
        json_file.parent.mkdir()
        data = {"company": "Astranis", "founders": [{"name": "José Gedmark"}]}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        client = BrowserAcquisitionClient(workspace=workspace)
        # Relative path within workspace
        loaded = client.fetch_research_json("research/test.json")
        assert loaded == data, f"Expected {data}, got {loaded}"

        # Path traversal rejection
        escape_file = Path(tmpdir) / "secret.json"
        escape_file.write_text("{}", encoding="utf-8")
        try:
            client.fetch_research_json("../secret.json")
            raise AssertionError("Expected ValueError on workspace path traversal")
        except ValueError:
            pass


def test_network_requests_parsing() -> None:
    from unittest.mock import patch

    client = BrowserAcquisitionClient()

    # 1. Test dict shape with "requests"
    dict_payload = json.dumps({"requests": [{"index": 1, "method": "GET", "url": "https://ycombinator.com"}]})
    with patch("kalki_runtime.browser.call_playwright_tool", return_value=dict_payload):
        reqs = client.fetch_network_requests()
        assert len(reqs) == 1 and reqs[0]["url"] == "https://ycombinator.com"

    # 2. Test list shape
    list_payload = json.dumps([{"index": 2, "method": "POST", "url": "https://algolia.net"}])
    with patch("kalki_runtime.browser.call_playwright_tool", return_value=list_payload):
        reqs = client.fetch_network_requests()
        assert len(reqs) == 1 and reqs[0]["url"] == "https://algolia.net"


def main() -> None:
    test_unwrap_mcp_text()
    test_unicode_preservation()
    test_fetch_research_json()
    test_network_requests_parsing()
    print("BROWSER_ADAPTER_CHECK_OK")


if __name__ == "__main__":
    main()
