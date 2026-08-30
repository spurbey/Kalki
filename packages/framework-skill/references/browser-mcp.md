# Browser MCP

Use Playwright for bounded reconnaissance, not bulk collection.

1. Discover the configured Playwright tools through TrueForge.
2. Open the user-facing source with `browser_navigate`.
3. Use `browser_snapshot` to confirm the source identity and interact with visible controls when needed.
4. Use `browser_network_requests` to list relevant non-static requests.
5. Inspect only promising requests with `browser_network_request`.
6. Record the observed URL, method, parameters, response paths, and source meaning as compact files under `research/`.
7. Stop browsing and generate the source operator from that evidence.

Prefer a stable JSON endpoint over rendered DOM extraction. `browser_network_state_set` only simulates online or offline state and is not a request-capture tool.

Do not save cookies, credentials, or complete responses. If no deterministic HTTPS data path is available, report that limitation instead of inventing selectors or unsupported browser automation.
