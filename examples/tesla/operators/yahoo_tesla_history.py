import asyncio
import hashlib
import json
import re
import sys
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance

_MCP_CLIENT_DIR = "/opt/tf/mcp-client"
_REQUEST_LINE = re.compile(r"^(\d+)\.\s+\[GET\]\s+(\S+)\s+=>\s+\[(\d+)\]", re.MULTILINE)
_FIXED_QUERY = {
    "interval": "1d",
    "includePrePost": "false",
    "events": "div|split",
    "lang": "en-US",
    "region": "US",
}


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_text(item) for item in value)
    if isinstance(value, dict):
        return str(value.get("text") or "")
    text = getattr(value, "text", None)
    return text if isinstance(text, str) else str(value)


async def _captured_chart(url_pattern: str) -> tuple[dict[str, Any], str, str, str]:
    if _MCP_CLIENT_DIR not in sys.path:
        sys.path.insert(0, _MCP_CLIENT_DIR)
    from mcp_client import call_tool

    listing = _text(
        await call_tool(
            "playwright",
            "browser_network_requests",
            {"static": True, "filter": url_pattern},
        )
    )
    matches = [match for match in _REQUEST_LINE.finditer(listing) if match.group(3) == "200"]
    if not matches:
        raise RuntimeError(f"navigate Chrome to the Yahoo endpoint before running the pipeline: {url_pattern}")

    selected = matches[-1]
    body = _text(
        await call_tool(
            "playwright",
            "browser_network_request",
            {"index": int(selected.group(1)), "part": "response-body"},
        )
    ).strip()
    if body.startswith("### Result"):
        body = body[len("### Result") :].lstrip()
    marker = body.find("### Page")
    if marker != -1:
        body = body[:marker].rstrip()

    return (
        json.loads(body),
        selected.group(2),
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        hashlib.sha256(body.encode("utf-8")).hexdigest(),
    )


class YahooTeslaHistorySource:
    def collect(self, context: RunContext):
        symbol = str(context.config["symbol"])
        endpoint = str(context.config["endpoint"])
        start = date.fromisoformat(str(context.config["start_date"]))
        payload, final_url, retrieved_at, response_hash = asyncio.run(
            _captured_chart(str(context.config["capture_url_pattern"]))
        )
        approved_url = urlsplit(endpoint)
        captured_url = urlsplit(final_url)
        if (
            captured_url.scheme != "https"
            or captured_url.hostname != approved_url.hostname
            or captured_url.port not in (None, 443)
            or captured_url.path != approved_url.path
        ):
            raise ValueError(f"captured an unexpected Yahoo endpoint: {final_url}")
        query = parse_qs(captured_url.query, keep_blank_values=True)
        if set(query) != {*_FIXED_QUERY, "period1", "period2"}:
            raise ValueError(f"captured unreviewed Yahoo query parameters: {final_url}")
        if any(query.get(name) != [value] for name, value in _FIXED_QUERY.items()):
            raise ValueError(f"captured unreviewed Yahoo query values: {final_url}")
        try:
            period1 = int(query["period1"][0])
            period2 = int(query["period2"][0])
        except (KeyError, ValueError, IndexError) as error:
            raise ValueError(f"captured invalid Yahoo date range: {final_url}") from error
        if len(query["period1"]) != 1 or len(query["period2"]) != 1 or period1 >= period2:
            raise ValueError(f"captured invalid Yahoo date range: {final_url}")

        chart = payload.get("chart")
        results = chart.get("result") if isinstance(chart, dict) and chart.get("error") is None else None
        if not isinstance(results, list) or len(results) != 1:
            raise ValueError("Yahoo chart response is invalid")

        result = results[0]
        meta = result.get("meta")
        timestamps = result.get("timestamp")
        indicators = result.get("indicators")
        quotes = indicators.get("quote") if isinstance(indicators, dict) else None
        adjusted = indicators.get("adjclose") if isinstance(indicators, dict) else None
        if (
            not isinstance(meta, dict)
            or meta.get("symbol") != symbol
            or meta.get("exchangeTimezoneName") != "America/New_York"
            or meta.get("dataGranularity") != "1d"
        ):
            raise ValueError("Yahoo metadata does not match the reviewed TSLA source")
        if not isinstance(timestamps, list) or not isinstance(quotes, list) or len(quotes) != 1:
            raise ValueError("Yahoo quote arrays are missing")

        quote = quotes[0]
        adj_close = adjusted[0].get("adjclose") if isinstance(adjusted, list) and len(adjusted) == 1 else None
        arrays = [quote.get(name) for name in ("open", "high", "low", "close", "volume")]
        if not all(isinstance(values, list) and len(values) == len(timestamps) for values in arrays):
            raise ValueError("Yahoo quote arrays do not align with timestamps")
        if adj_close is None:
            adj_close = [None] * len(timestamps)
        if not isinstance(adj_close, list) or len(adj_close) != len(timestamps):
            raise ValueError("Yahoo adjusted-close array does not align with timestamps")

        exchange_timezone = ZoneInfo(meta["exchangeTimezoneName"])
        incomplete_session = self._incomplete_session_date(meta, exchange_timezone)
        today = datetime.now(exchange_timezone).date()
        price_decimals = int(meta.get("priceHint", 2))
        currency = str(meta["currency"])

        for index, timestamp in enumerate(timestamps):
            if not isinstance(timestamp, int):
                raise ValueError("Yahoo timestamp is invalid")
            trading_date = datetime.fromtimestamp(timestamp, exchange_timezone).date()
            if trading_date < start or trading_date > today or trading_date == incomplete_session:
                continue

            open_value, high, low, close, volume = (values[index] for values in arrays)
            required = (open_value, high, low, close)
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in required):
                raise ValueError(f"Yahoo OHLC value is invalid for {trading_date}")
            if not isinstance(volume, int) or isinstance(volume, bool) or volume < 0:
                raise ValueError(f"Yahoo volume is invalid for {trading_date}")

            adjusted_value = adj_close[index]
            if adjusted_value is not None and (
                not isinstance(adjusted_value, (int, float)) or isinstance(adjusted_value, bool)
            ):
                raise ValueError(f"Yahoo adjusted close is invalid for {trading_date}")

            data = {
                "date": trading_date.isoformat(),
                "open": round(float(open_value), price_decimals),
                "high": round(float(high), price_decimals),
                "low": round(float(low), price_decimals),
                "close": round(float(close), price_decimals),
                "adj_close": None if adjusted_value is None else round(float(adjusted_value), price_decimals),
                "volume": volume,
                "currency": currency,
                "symbol": symbol,
            }
            if not (data["low"] <= data["open"] <= data["high"] and data["low"] <= data["close"] <= data["high"]):
                raise ValueError(f"Yahoo price bounds are invalid for {trading_date}")

            yield RecordEnvelope(
                data=data,
                dedupe_key=data["date"],
                provenance=Provenance(
                    kind="direct",
                    source_url=final_url,
                    retrieved_at=retrieved_at,
                    source_record_id=f"{symbol}:{data['date']}",
                    evidence_path="research/yahoo-network-evidence.json",
                    source_hash=response_hash,
                ),
            )

    @staticmethod
    def _incomplete_session_date(meta: dict[str, Any], exchange_timezone: ZoneInfo) -> date | None:
        market_time = int(meta["regularMarketTime"])
        market_date = datetime.fromtimestamp(market_time, exchange_timezone).date()
        regular_close = int(meta["currentTradingPeriod"]["regular"]["end"])
        now = datetime.now(exchange_timezone)
        return market_date if now.date() == market_date and now.timestamp() < regular_close else None
