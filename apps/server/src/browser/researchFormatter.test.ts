import { describe, expect, it } from "vitest";
import { formatResearchResult } from "./researchFormatter.js";

describe("research result formatting", () => {
  it("keeps useful page structure and removes noisy secrets", () => {
    const page = formatResearchResult(
      "snapshot",
      [
        "### Page",
        "- Page URL: https://example.com/",
        "- Page Title: Example",
        "### Snapshot",
        "```yaml",
        '- heading \"Founders\" [ref=a1]',
        '- link \"Ada\" [ref=a2] [cursor=pointer]:',
        "- /url: /founders/ada",
        "```",
      ].join("\n"),
    );
    expect(page.url).toBe("https://example.com/");
    expect(page.title).toBe("Example");
    expect(page.summary).toContain("Founders");
    expect(page.summary).not.toContain("### Snapshot");

    const network = formatResearchResult(
      "network",
      [
        "### Result",
        "1. [POST] https://api.example.test/query?api_key=secret => [200] OK",
        "2. [POST] https://analytics.google.com/g/collect => [200] OK",
      ].join("\n"),
    );
    expect(network.summary).toContain("api_key=<redacted>");
    expect(network.summary).not.toContain("analytics.google.com");
  });
});
