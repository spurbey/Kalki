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
  count?: number;
};

const maxToolArgumentsForName = 64_000;

function toolName(value: JsonValue): string {
  if (!isObject(value)) return "Tool call";
  const toolInfoName =
    isObject(value.toolInfo) && typeof value.toolInfo.name === "string"
      ? value.toolInfo.name
      : isObject(value.tool_info) && typeof value.tool_info.name === "string"
        ? value.tool_info.name
        : null;
  const functionName =
    isObject(value.function) && typeof value.function.name === "string"
      ? value.function.name
      : null;
  if (toolInfoName) return toolInfoName;
  if (functionName) return functionName;
  return "Tool call";
}

function parsedArguments(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as JsonValue;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringField(
  value: JsonValue,
  ...names: string[]
): string | null {
  if (!isObject(value)) return null;
  for (const name of names) {
    if (typeof value[name] === "string" && value[name].trim()) {
      return value[name].trim();
    }
  }
  return null;
}

function toolPresentation(
  canonicalName: string,
  argumentsText: string,
): { title: string; text: string } {
  const wrapper = parsedArguments(argumentsText);
  const name =
    canonicalName === "call_tool"
      ? stringField(wrapper, "tool_name", "name") || canonicalName
      : canonicalName;
  const input =
    wrapper && isObject(wrapper.input)
      ? wrapper.input
      : wrapper && isObject(wrapper.arguments)
        ? wrapper.arguments
        : wrapper;
  const intent = stringField(input, "intent") || stringField(wrapper, "intent");
  const url = stringField(input, "url") || stringField(wrapper, "url");
  const path =
    stringField(input, "path", "file_path", "task_path", "schema_path") ||
    stringField(wrapper, "path", "file_path", "task_path", "schema_path");

  if (name === "exec") {
    return { title: "Bash", text: intent || "Run command" };
  }
  if (name === "browser_navigate") {
    return { title: "Browser", text: url ? `Open ${url}` : "Open page" };
  }
  if (name === "browser_evaluate") {
    return { title: "Browser", text: intent || "Inspect page" };
  }
  if (name === "browser_snapshot") {
    return { title: "Browser", text: "Capture page structure" };
  }
  if (name === "browser_click") {
    return {
      title: "Browser",
      text: `Click ${stringField(input, "element", "selector", "ref") || "page element"}`,
    };
  }
  if (name === "browser_type") {
    return {
      title: "Browser",
      text: `Type into ${stringField(input, "element", "selector", "ref") || "page"}`,
    };
  }

  const workbookActions: Record<string, string> = {
    get_workbook_context: "Load workbook context",
    register_task: "Register task contract",
    register_schema: "Register table schema",
    start_run: "Start pipeline run",
    get_production_authorization: "Check production authorization",
    publish_batch: "Publish data batch",
    record_artifact: "Record output artifact",
    complete_run: "Complete pipeline run",
    promote_skill: "Promote reusable skill",
  };
  if (workbookActions[name]) {
    return { title: "Workbook", text: intent || workbookActions[name] };
  }
  if (name === "ask_user_question") {
    return { title: "Review", text: "Request your input" };
  }
  if (name === "list_tools") {
    return { title: "Tools", text: "Inspect available tools" };
  }
  if (canonicalName === "call_tool" && name === canonicalName) {
    return { title: "Tool", text: "Prepare tool call" };
  }
  return {
    title: "Tool",
    text: intent || (path ? `${label(name)} ${path}` : label(name)),
  };
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
  const toolNameBySlot = new Map<string, string>();
  const toolArgumentsBySlot = new Map<string, string>();

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
    const turnId =
      typeof stored.payload.turn_id === "string"
        ? stored.payload.turn_id
        : eventId;
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
        let item = reasoningById.get(turnId);
        if (!item) {
          item = {
            key: `reasoning-${turnId}`,
            kind: "reasoning",
            title: "Thought",
            text: "",
            timestamp,
          };
          reasoningById.set(turnId, item);
          items.push(item);
        }
        if (eventType.endsWith(".delta")) item.text += reasoning;
        else if (!item.text) item.text = reasoning;
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
          const nextName = toolName(call);
          if (nextName !== "Tool call") toolNameBySlot.set(slot, nextName);
          const canonicalName = toolNameBySlot.get(slot) ?? "Tool call";
          let tool = toolBySlot.get(slot);
          if (!tool) {
            const presentation = toolPresentation(canonicalName, "");
            tool = {
              key: `tool-${id ?? slot}`,
              kind: "tool",
              title: presentation.title,
              text: presentation.text,
              timestamp,
              status: "running",
            };
            toolBySlot.set(slot, tool);
            items.push(tool);
          }
          const detail = toolDetail(call);
          if (detail) {
            const argumentsText = `${toolArgumentsBySlot.get(slot) ?? ""}${detail}`;
            toolArgumentsBySlot.set(
              slot,
              argumentsText.slice(0, maxToolArgumentsForName),
            );
            tool.detail = argumentsText.slice(0, 1200);
          }
          const presentation = toolPresentation(
            canonicalName,
            toolArgumentsBySlot.get(slot) ?? "",
          );
          tool.title = presentation.title;
          tool.text = presentation.text;
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
        const failed = wrapped.isError === true || wrapped.is_error === true;
        existing.status = failed ? "error" : "success";
        existing.detail =
          contentText(wrapped.content).slice(0, 1200) || existing.detail;
      } else {
        items.push({
          key: `tool-response-${stored.seq}`,
          kind: "tool",
          title: "Tool response",
          text: "Return tool output",
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
      continue;
    }

    if (eventType === "turn.done") {
      const state =
        isObject(wrapped.state) && typeof wrapped.state.status === "string"
          ? wrapped.state.status
          : "done";
      if (state !== "done") {
        items.push({
          key: `status-${stored.seq}`,
          kind: state === "error" ? "error" : "status",
          title: state === "error" ? "Turn failed" : "Turn stopped",
          text: label(state),
          timestamp,
          status: state === "error" ? "error" : "success",
        });
      }
      continue;
    }

    if (eventType === "sandbox.created") {
      items.push({
        key: `status-${stored.seq}`,
        kind: "status",
        title: "Workspace",
        text: "Daytona sandbox ready",
        detail:
          typeof wrapped.sandboxId === "string"
            ? wrapped.sandboxId
            : typeof wrapped.sandbox_id === "string"
              ? wrapped.sandbox_id
              : undefined,
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

    if (eventType === "mcp.initialize") continue;
  }

  const visible = items.filter((item) => item.text || item.kind === "tool");
  const compacted: ActivityItem[] = [];
  for (const item of visible) {
    const previous = compacted.at(-1);
    if (
      item.kind === "tool" &&
      previous?.kind === "tool" &&
      previous.title === item.title &&
      previous.text === item.text &&
      previous.status === item.status
    ) {
      previous.count = (previous.count ?? 1) + 1;
      previous.timestamp = item.timestamp;
      previous.detail = item.detail ?? previous.detail;
      continue;
    }
    compacted.push(item);
  }
  return compacted;
}
