import type { JsonValue, WorkbookEvent } from "@kalki/contracts";
import { contentText, isObject, label } from "./format.js";

export type ActivityItem = {
  key: string;
  kind: "assistant" | "reasoning" | "user" | "tool" | "status" | "error";
  title: string;
  text: string;
  detail?: string | undefined;
  timestamp: string;
  status?: "running" | "success" | "error";
};

function toolName(value: JsonValue): string {
  if (!isObject(value)) return "Tool call";
  if (isObject(value.toolInfo) && typeof value.toolInfo.name === "string")
    return value.toolInfo.name;
  if (isObject(value.tool_info) && typeof value.tool_info.name === "string")
    return value.tool_info.name;
  if (isObject(value.function) && typeof value.function.name === "string")
    return value.function.name;
  return "Tool call";
}

function toolDetail(value: JsonValue): string {
  if (
    !isObject(value) ||
    !isObject(value.function) ||
    typeof value.function.arguments !== "string"
  ) {
    return "";
  }
  return value.function.arguments;
}

function messageContent(value: JsonValue | undefined) {
  if (typeof value === "string") return { text: value, reasoning: "" };
  if (!Array.isArray(value)) return { text: "", reasoning: "" };

  let text = "";
  let reasoning = "";
  for (const part of value) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!isObject(part)) continue;
    const partText =
      typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : "";
    if (part.type === "reasoning") reasoning += partText;
    else text += partText;
  }
  return { text, reasoning };
}

export function activityFromEvents(events: WorkbookEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const assistantById = new Map<string, ActivityItem>();
  const reasoningById = new Map<string, ActivityItem>();
  const toolById = new Map<string, ActivityItem>();
  const toolBySlot = new Map<string, ActivityItem>();

  for (const stored of [...events].sort(
    (left, right) => left.seq - right.seq,
  )) {
    const wrapped = isObject(stored.payload.event)
      ? stored.payload.event
      : stored.payload;
    const eventType =
      typeof wrapped.type === "string"
        ? wrapped.type
        : stored.type.replace(/^agent\./, "");
    const eventId =
      typeof wrapped.id === "string" ? wrapped.id : String(stored.seq);
    const timestamp =
      typeof wrapped.createdAt === "string"
        ? wrapped.createdAt
        : typeof wrapped.created_at === "string"
          ? wrapped.created_at
          : stored.created_at;

    if (eventType === "user.message" || eventType === "user.tool_response") {
      items.push({
        key: `user-${stored.seq}`,
        kind: "user",
        title: eventType === "user.tool_response" ? "Your answer" : "You",
        text: contentText(wrapped.content),
        timestamp,
      });
      continue;
    }

    if (eventType === "model.message" || eventType === "model.message.delta") {
      const content = messageContent(wrapped.content);
      const reasoning =
        content.reasoning ||
        contentText(wrapped.reasoning) ||
        contentText(wrapped.reasoning_content);
      if (reasoning) {
        let item = reasoningById.get(eventId);
        if (!item) {
          item = {
            key: `reasoning-${eventId}`,
            kind: "reasoning",
            title: "Reasoning",
            text: "",
            timestamp,
          };
          reasoningById.set(eventId, item);
          items.push(item);
        }
        item.text = eventType.endsWith(".delta")
          ? `${item.text}${reasoning}`
          : reasoning;
      }

      const text = content.text;
      let item = assistantById.get(eventId);
      if (!item && text) {
        item = {
          key: `assistant-${eventId}`,
          kind: "assistant",
          title: "Kalki",
          text: "",
          timestamp,
        };
        assistantById.set(eventId, item);
        items.push(item);
      }
      if (item && text)
        item.text = eventType.endsWith(".delta") ? `${item.text}${text}` : text;

      const calls = Array.isArray(wrapped.toolCalls)
        ? wrapped.toolCalls
        : Array.isArray(wrapped.tool_calls)
          ? wrapped.tool_calls
          : [];
      if (calls.length) {
        for (const call of calls) {
          if (!isObject(call)) continue;
          const index =
            typeof call.index === "number" || typeof call.index === "string"
              ? String(call.index)
              : "0";
          const slot = `${eventId}-${index}`;
          const id = typeof call.id === "string" ? call.id : null;
          let tool = toolBySlot.get(slot);
          if (!tool) {
            tool = {
              key: `tool-${id ?? slot}`,
              kind: "tool",
              title: toolName(call),
              text: "Running",
              timestamp,
              status: "running",
            };
            toolBySlot.set(slot, tool);
            items.push(tool);
          }
          const name = toolName(call);
          if (name !== "Tool call") tool.title = name;
          const detail = toolDetail(call);
          if (detail)
            tool.detail = `${tool.detail ?? ""}${detail}`.slice(0, 1200);
          if (id) toolById.set(id, tool);
        }
      }
      continue;
    }

    if (eventType === "tool.response") {
      const callId =
        typeof wrapped.toolCallId === "string"
          ? wrapped.toolCallId
          : typeof wrapped.tool_call_id === "string"
            ? wrapped.tool_call_id
            : eventId;
      const existing = toolById.get(callId);
      if (existing) {
        existing.status = "success";
        existing.text = "Completed";
        existing.detail =
          contentText(wrapped.content).slice(0, 1200) || existing.detail;
      } else {
        items.push({
          key: `tool-response-${stored.seq}`,
          kind: "tool",
          title: "Tool response",
          text: "Completed",
          detail: contentText(wrapped.content).slice(0, 1200),
          timestamp,
          status: "success",
        });
      }
      continue;
    }

    if (eventType === "turn.created") {
      if (Array.isArray(wrapped.input)) {
        for (const input of wrapped.input) {
          if (
            !isObject(input) ||
            (input.type !== "user.message" &&
              input.type !== "user.tool_response")
          ) {
            continue;
          }
          items.push({
            key: `user-${stored.seq}-${items.length}`,
            kind: "user",
            title: input.type === "user.tool_response" ? "Your answer" : "You",
            text: contentText(input.content),
            timestamp,
          });
        }
      }
      items.push({
        key: `status-${stored.seq}`,
        kind: "status",
        title: "Turn started",
        text: "TrueForge is working",
        timestamp,
        status: "running",
      });
      continue;
    }

    if (eventType === "turn.done") {
      const state =
        isObject(wrapped.state) && typeof wrapped.state.status === "string"
          ? wrapped.state.status
          : "done";
      items.push({
        key: `status-${stored.seq}`,
        kind: state === "error" ? "error" : "status",
        title: state === "error" ? "Turn failed" : "Turn finished",
        text: label(state),
        timestamp,
        status: state === "error" ? "error" : "success",
      });
      continue;
    }

    if (eventType === "sandbox.created") {
      items.push({
        key: `status-${stored.seq}`,
        kind: "status",
        title: "Sandbox ready",
        text:
          typeof wrapped.sandboxId === "string"
            ? wrapped.sandboxId
            : typeof wrapped.sandbox_id === "string"
              ? wrapped.sandbox_id
              : "Daytona workspace created",
        timestamp,
        status: "success",
      });
      continue;
    }

    if (eventType === "thread.created" || eventType === "thread.done") {
      items.push({
        key: `status-${stored.seq}`,
        kind: "status",
        title:
          eventType === "thread.created"
            ? "Subagent started"
            : "Subagent finished",
        text: typeof wrapped.name === "string" ? wrapped.name : "Agent thread",
        timestamp,
        status: eventType === "thread.created" ? "running" : "success",
      });
      continue;
    }

    if (eventType === "mcp.initialize") {
      items.push({
        key: `status-${stored.seq}`,
        kind: "status",
        title: "Tools connected",
        text: "MCP tools initialized",
        timestamp,
        status: "success",
      });
    }
  }

  return items.filter((item) => item.text || item.kind === "tool");
}
