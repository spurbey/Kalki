# Browser MCP

Use Playwright for bounded reconnaissance and browser-backed source access.

1. Discover the configured Playwright tools through TrueForge.
2. Open the user-facing source with `browser_navigate`.
3. Use `browser_snapshot` to confirm the source identity and interact with visible controls when needed.
4. Use `browser_network_requests` to list relevant non-static requests.
5. Inspect only promising requests with `browser_network_request`.
6. Record the observed URL, method, parameters, response paths, and source meaning as compact files under `research/`.
7. Save the repeatable URL pattern or compact URL list under `research/` and generate the source operator from that evidence.

For execution, keep the approval boundary explicit:

1. The root coordinator directly navigates to the reviewed page or deterministic JSON endpoint immediately before the pipeline run.
2. The generated operator fetches the remaining reviewed URLs through `context.browser`:
   ```python
   pages = context.browser.fetch_pages(urls[:5])
   for page in pages:
       if page["error"]:
           continue
       html = page["body"] or ""
       # Parse the bounded body deterministically inside the sandbox.
   ```
3. Use batches of at most five URLs. The operator parses and reduces bodies inside the sandbox; it never prints full responses into model context and never writes ad-hoc MCP decoding scripts.

The bridge compresses page bodies on the host before transport; `context.browser.fetch_pages` decodes them, so operators only handle the `body` string shown above.

Code Mode cannot call Playwright tools marked destructive, including `browser_navigate` and `browser_evaluate`. Do not disable or bypass that check.

Prefer a stable JSON endpoint when reconnaissance proves one exists. Otherwise fetch reviewed HTML pages through `context.browser.fetch_pages`; `browser_network_state_set` only simulates online or offline state and is not a request-capture tool.

Do not save cookies, credentials, or complete responses. If no deterministic HTTPS data path is available, report that limitation instead of inventing selectors or unsupported browser automation.
