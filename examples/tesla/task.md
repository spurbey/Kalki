# Tesla Highest Prices

## Objective

Collect TSLA daily history from 2025-01-01 through the last completed New York trading date and return the three days with the highest daily high.

## Source

Use Yahoo Finance for browser reconnaissance and its chart JSON endpoint for deterministic collection.

## Tables

- `tesla-history`: daily OHLCV history.
- `tesla-top-3`: three rows ranked by `high DESC, date ASC`.

## Acceptance

- A bounded test writes exactly five source rows and three derived rows.
- Test rows remain in sandbox JSONL only.
- Every row has provenance and a stable dedupe key.

## Non-Goals

No live quotes, forecasting, investment advice, or additional tickers.
