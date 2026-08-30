from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from kalki_runtime.contracts import RecordEnvelope, RunContext
from kalki_runtime.provenance import Provenance
from kalki_runtime.schema_loader import hash_json


class YahooTeslaHistorySource:
    def collect(self, context: RunContext):
        symbol = context.config["symbol"]
        interval = context.config["interval"]
        endpoint = context.config["endpoint"]
        if symbol != "TSLA" or interval != "1d":
            raise ValueError("Tesla workflow requires symbol TSLA and interval 1d")

        exchange_timezone = ZoneInfo("America/New_York")
        start = date.fromisoformat(str(context.config["start_date"]))
        end = datetime.now(exchange_timezone).date()
        if context.mode == "test":
            end = min(end, start + timedelta(days=14))
        period1 = int(datetime.combine(start, time.min, exchange_timezone).timestamp())
        period2 = int(datetime.combine(end, time.min, exchange_timezone).timestamp())
        response = context.http.get_json(
            str(endpoint),
            params={
                "period1": period1,
                "period2": period2,
                "interval": interval,
                "events": "history",
                "includeAdjustedClose": "true",
            },
            headers={"Accept": "application/json", "User-Agent": "Kalki/0.1"},
        )

        chart = response.data.get("chart") if isinstance(response.data, dict) else None
        results = chart.get("result") if isinstance(chart, dict) and chart.get("error") is None else None
        if not isinstance(results, list) or len(results) != 1:
            raise ValueError("Yahoo chart response is invalid")
        result = results[0]
        meta = result.get("meta")
        timestamps = result.get("timestamp")
        indicators = result.get("indicators")
        quotes = indicators.get("quote") if isinstance(indicators, dict) else None
        adjusted = indicators.get("adjclose") if isinstance(indicators, dict) else None
        if not isinstance(meta, dict) or meta.get("symbol") != "TSLA" or meta.get("exchangeTimezoneName") != "America/New_York":
            raise ValueError("Yahoo metadata does not match TSLA")
        if not isinstance(timestamps, list) or not isinstance(quotes, list) or len(quotes) != 1:
            raise ValueError("Yahoo quote arrays are missing")
        quote = quotes[0]
        adjclose = adjusted[0].get("adjclose") if isinstance(adjusted, list) and len(adjusted) == 1 else None
        arrays = [quote.get(name) for name in ("open", "high", "low", "close", "volume")] + [adjclose]
        if not all(isinstance(values, list) and len(values) == len(timestamps) for values in arrays):
            raise ValueError("Yahoo quote arrays do not align with timestamps")

        records = []
        for index, timestamp in enumerate(timestamps):
            if not isinstance(timestamp, int):
                raise ValueError("Yahoo timestamp is invalid")
            open_value, high, low, close, volume, adjusted_close = (values[index] for values in arrays)
            required = (open_value, high, low, close)
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in required):
                raise ValueError("Yahoo OHLC value is invalid")
            if not isinstance(volume, int) or isinstance(volume, bool) or volume < 0:
                raise ValueError("Yahoo volume is invalid")
            if adjusted_close is not None and (not isinstance(adjusted_close, (int, float)) or isinstance(adjusted_close, bool)):
                raise ValueError("Yahoo adjusted close is invalid")

            trading_date = datetime.fromtimestamp(timestamp, exchange_timezone).date().isoformat()
            fragment = {
                "timestamp": timestamp,
                "open": open_value,
                "high": high,
                "low": low,
                "close": close,
                "adj_close": adjusted_close,
                "volume": volume,
                "currency": meta.get("currency"),
                "symbol": meta.get("symbol"),
            }
            records.append(
                RecordEnvelope(
                    data={"date": trading_date, **{key: value for key, value in fragment.items() if key != "timestamp"}},
                    dedupe_key=trading_date,
                    provenance=Provenance(
                        kind="direct",
                        source_url=response.final_url,
                        retrieved_at=response.retrieved_at,
                        source_record_id=f"TSLA:{trading_date}",
                        evidence_path="research/yahoo-network-evidence.json",
                        source_hash=hash_json(fragment),
                    ),
                )
            )

        yield from sorted(records, key=lambda record: record.data["date"])
