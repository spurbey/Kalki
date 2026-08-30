# Browser MCP

Use Playwright to inspect the human-facing source and identify the deterministic data endpoint.

For Yahoo TSLA history:

1. Open `https://finance.yahoo.com/quote/TSLA/history/`.
2. Confirm the symbol, historical-data meaning, interval, and date controls.
3. Record the chart endpoint and required response paths.
4. Save compact evidence under `research/`; do not save cookies or full responses.
5. Use the JSON endpoint in the operator instead of scraping rendered table rows.

Browser failure does not justify inventing selectors, endpoint fields, or source evidence.
