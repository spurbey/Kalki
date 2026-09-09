# Browser MCP

Use the Kalki browser research tools for bounded reconnaissance and browser-backed source access. They keep raw Playwright output out of the coordinator context.

1. Open the user-facing source with `browser_research_navigate`.
2. Use `browser_research_snapshot` to confirm source identity and inspect bounded visible structure.
3. Use `browser_research_click` only with a reference from the latest observation.
4. Use `browser_research_network` to list relevant non-static requests, then inspect only one promising request part at a time.
5. Use `browser_research_evaluate` only for a small field or link extraction; never return full HTML.
6. Record the returned URL, method, parameters, response paths, and source meaning as compact files under `research/`.
7. Save the repeatable URL pattern or compact URL list under `research/` and generate the source operator from that evidence.

Each research response is bounded and structured as URL, title, summary, items, and a truncation flag. Full browser output remains outside the model context.

### Reconnaissance Completion & Anti-Pagination Guardrails

- **State-Driven Exit**: Take whatever navigation, search, or filter interaction steps are necessary to reach the target data. Reconnaissance has an unambiguous stopping condition: the moment target schema fields (e.g. price, availability, attributes, specs, or entity names) are observed on a representative item or payload, reconnaissance is complete.
- **Immediate Physical Capture**: Persist the physical evidence sample immediately by running `PYTHONPATH="$PWD/.kalki/deps:/opt/tf/mcp-client" python -m kalki_runtime.research_cli capture --url <url> --out research/captures/<name>.html`.
- **Exit Browser Immediately**: Leave the browser once the capture is saved. Author the schema and operator offline against the saved capture in Daytona.
- **Anti-Pagination in Reconnaissance**: Never paginate search results (e.g. browsing page 2, 3, 4) or inspect multiple detail items interactively to gauge catalog volume or collect records. Multi-item collection and pagination belong strictly to the generated operator inside `pipeline_cli test`.

For execution, keep the approval boundary explicit:

1. The root coordinator uses `browser_research_navigate` to open the reviewed page or deterministic JSON endpoint immediately before the pipeline run.
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

### Web Data Extraction Patterns
* **Embedded State**: Modern web applications frequently embed structured state inside `<script type="application/json">`, `<script id="__NEXT_DATA__">`, `<script id="__NUXT_DATA__">`, or state attributes. Extract this embedded JSON using standard Python `re`, `html.unescape`, and `json.loads(..., strict=False)` inside the operator.
* **Static HTML**: For server-rendered HTML tables, lists, or semantic cards, extract fields directly using regex or standard `html.parser`.
* **Standard Library Preference**: Prefer Python standard library modules (`re`, `json`, `html`, `urllib.parse`) inside operators rather than installing heavy external DOM parsing packages.


Do not save cookies, credentials, or complete responses. If no deterministic HTTPS data path is available, report that limitation instead of inventing selectors or unsupported browser automation.
