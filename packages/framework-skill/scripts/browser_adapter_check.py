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


def test_fetch_research_json() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        json_file = Path(tmpdir) / "test.json"
        data = {"company": "Astranis", "founders": [{"name": "John Gedmark"}]}
        json_file.write_text(json.dumps(data), encoding="utf-8")

        client = BrowserAcquisitionClient()
        loaded = client.fetch_research_json(json_file)
        assert loaded == data, f"Expected {data}, got {loaded}"


def main() -> None:
    test_unwrap_mcp_text()
    test_fetch_research_json()
    print("BROWSER_ADAPTER_CHECK_OK")


if __name__ == "__main__":
    main()
