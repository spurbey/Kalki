import type { JsonObject, JsonValue } from "@kalki/contracts";

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function label(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 8)}...${value.slice(-6)}` : "Not registered";
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function cellText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function contentText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isObject(part)) return "";
        return typeof part.text === "string"
          ? part.text
          : typeof part.content === "string"
            ? part.content
            : "";
      })
      .join("");
  }
  if (isObject(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return "";
}
