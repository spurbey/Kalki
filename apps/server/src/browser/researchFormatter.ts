import type { BrowserResearchData } from "@kalki/contracts";

const MAX_SUMMARY_CHARS = 4_000;
const MAX_ITEM_CHARS = 600;
const MAX_ITEMS = 40;

type ResearchAction = BrowserResearchData["action"];

function clip(value: string, limit: number): [string, boolean] {
  if (value.length <= limit) return [value, false];
  return [`${value.slice(0, Math.max(0, limit - 3))}...`, true];
}

function redact(value: string): string {
  return value
    .replace(
      /([?&](?:[^=&]*(?:key|token|secret|password|authorization)[^=&]*)=)[^&\s]*/gi,
      "$1<redacted>",
    )
    .replace(/(Bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/\bsk-[A-Za-z0-9._-]+\b/g, "<redacted>");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(key|token|secret|password|authorization)/i.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return url.toString();
  } catch {
    return redact(value);
  }
}

function pageField(raw: string, label: string): string | null {
  const match = raw.match(new RegExp(`^[- ]*${label}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || null;
}

function resultBody(raw: string): string {
  let body = raw.replace(/\r/g, "").trim();
  const result = body.match(/^###\s+Result(?:\s+-[^\n]*)?\s*\n?/im);
  if (result?.index !== undefined) body = body.slice(result.index + result[0].length);

  const markers = [
    "\n### Ran Playwright code",
    "\n### Page",
    "\n### Snapshot",
    "\n### Events",
  ];
  const end = markers
    .map((marker) => body.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (end !== undefined) body = body.slice(0, end);

  return body
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function snapshotBody(raw: string): string {
  const normalized = raw.replace(/\r/g, "");
  const marker = normalized.search(/^###\s+Snapshot\s*$/im);
  if (marker < 0) return resultBody(normalized);
  let body = normalized.slice(marker).replace(/^###\s+Snapshot\s*\n?/i, "");
  const end = body.search(/^###\s+(?:Events|Page)\b/im);
  if (end >= 0) body = body.slice(0, end);
  return body.replace(/^```(?:yaml|text)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parsedValue(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  } catch {
    return null;
  }
}

function itemText(value: unknown, index: number): string {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return String(value);

  const object = value as Record<string, unknown>;
  const fields = [
    "index",
    "method",
    "url",
    "status",
    "resourceType",
    "content_type",
    "name",
    "type",
    "error",
  ];
  const parts = fields.flatMap((field) => {
    const fieldValue = object[field];
    return fieldValue === undefined || fieldValue === null
      ? []
      : [
          `${field}=${
            field === "url"
              ? redactUrl(String(fieldValue))
              : redact(String(fieldValue))
          }`,
        ];
  });
  if (parts.length === 0) {
    const [text] = clip(redact(JSON.stringify(value)), MAX_ITEM_CHARS);
    return `${index + 1}: ${text}`;
  }
  return parts.join(" | ");
}

function linesFromSnapshot(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("```") &&
        !line.startsWith("###") &&
        !/^-?\s*Page (URL|Title):/i.test(line),
    )
    .slice(0, MAX_ITEMS)
    .map(redact);
}

function isUsefulNetworkLine(line: string): boolean {
  return !/(google-analytics|analytics\.google\.com|google\.com\/g\/collect|doubleclick|sentry\.io|ingest\.|maps\.googleapis|favicon|\.woff2?(?:\?|$)|\.(?:css|js|png|jpg|jpeg|gif|svg)(?:\?|$)|unleash\/proxy)/i.test(
    line,
  );
}

export function formatResearchResult(
  action: ResearchAction,
  rawText: string,
  fallbackUrl: string | null = null,
): BrowserResearchData {
  const body = action === "navigate" || action === "snapshot" || action === "click"
    ? snapshotBody(rawText)
    : resultBody(rawText);
  const parsed = parsedValue(body);
  let items: string[];
  let summary: string;
  let truncated = false;

  if (Array.isArray(parsed)) {
    items = parsed.slice(0, MAX_ITEMS).map(itemText);
    truncated = parsed.length > MAX_ITEMS;
    summary = items.join("\n");
  } else if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const list = Array.isArray(object.requests)
      ? object.requests
      : Array.isArray(object.pages)
        ? object.pages
        : null;
    if (list) {
      items = list.slice(0, MAX_ITEMS).map(itemText);
      truncated = list.length > MAX_ITEMS;
      summary = items.join("\n");
    } else {
      const [text, clipped] = clip(JSON.stringify(parsed), MAX_SUMMARY_CHARS);
      items = [];
      summary = text;
      truncated = clipped;
    }
  } else {
    const sourceLines =
      action === "network"
        ? linesFromSnapshot(body).filter(isUsefulNetworkLine).slice(0, 20)
        : linesFromSnapshot(body);
    items = sourceLines.map((line, index) => {
      const [text, clipped] = clip(line, MAX_ITEM_CHARS);
      truncated ||= clipped;
      return `${index + 1}: ${text}`;
    });
    summary = items.join("\n");
  }

  const [boundedSummary, summaryClipped] = clip(summary, MAX_SUMMARY_CHARS);
  return {
    action,
    url: pageField(rawText, "Page URL") ?? fallbackUrl,
    title: pageField(rawText, "Page Title"),
    summary: redact(boundedSummary),
    items,
    truncated: truncated || summaryClipped,
  };
}
