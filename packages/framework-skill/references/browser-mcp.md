# Browser MCP

Use Playwright for bounded reconnaissance and browser-backed source access.

1. Discover the configured Playwright tools through TrueForge.
2. Open the user-facing source with `browser_navigate`.
3. Use `browser_snapshot` to confirm the source identity and interact with visible controls when needed.
4. Use `browser_network_requests` to list relevant non-static requests.
5. Inspect only promising requests with `browser_network_request`.
6. Record the observed URL, method, parameters, response paths, and source meaning as compact files under `research/`.
7. Generate the source operator from that evidence.

For execution, keep the approval boundary explicit:

1. The root coordinator directly navigates to the reviewed page or deterministic JSON endpoint immediately before the pipeline run.
2. The generated operator calls the safe `browser_network_requests` and `browser_network_request` tools through `mcp_client` to read the captured response body.
3. The operator parses and reduces that body inside the sandbox. It never prints the full response into model context.

Code Mode cannot call Playwright tools marked destructive, including `browser_navigate` and `browser_evaluate`. Do not disable or bypass that check.

Prefer direct coordinator navigation to a stable JSON endpoint over rendered DOM extraction. `browser_network_state_set` only simulates online or offline state and is not a request-capture tool.

Do not save cookies, credentials, or complete responses. If no deterministic HTTPS data path is available, report that limitation instead of inventing selectors or unsupported browser automation.
