import type {
  JsonObject,
  JsonValue,
  TrueForgeStreamEvent,
} from "@kalki/contracts";

const storedEventLimit = 16_384;
const storedStringLimit = 4_000;

/**
 * Shrinks an upstream agent event to something the event log can hold. Usage
 * counters, provider signatures, and encrypted blobs are dropped outright; long
 * strings and wide collections are clipped.
 */
export function compactAgentEvent(event: TrueForgeStreamEvent): JsonObject {
  const compact = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return value.slice(0, storedStringLimit);
    if (Array.isArray(value)) return value.slice(0, 50).map(compact);
    if (value && typeof value === "object") {
      const result: JsonObject = {};
      for (const [key, child] of Object.entries(value).slice(0, 50)) {
        const normalized = key.toLowerCase();
        if (
          normalized === "usage" ||
          normalized === "metrics" ||
          normalized.includes("signature") ||
          normalized.includes("encrypted")
        ) {
          continue;
        }
        result[key] = compact(child);
      }
      return result;
    }
    return value;
  };

  const payload = compact(event) as JsonObject;
  if (withinLimit(payload)) return payload;

  const fallback: JsonObject = {
    type: event.type.slice(0, 94),
    payload_truncated: true,
  };
  for (const key of ["id", "thread_id", "created_at", "content"]) {
    if (typeof event[key] === "string")
      fallback[key] = event[key].slice(0, storedStringLimit);
  }
  if (withinLimit(fallback)) return fallback;
  return { type: event.type.slice(0, 94), payload_truncated: true };
}

function withinLimit(payload: JsonObject) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8") <= storedEventLimit;
}
