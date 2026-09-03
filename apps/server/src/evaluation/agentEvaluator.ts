import {
  canonicalJson,
  WorkbookEvaluationSchema,
  type WorkbookEvent,
  type WorkbookEvaluation,
  type WorkbookSnapshot,
} from "@kalki/contracts";
import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;

type Observation = {
  action: string;
  signature: string;
  seq: number;
  turnId: string | null;
  read: boolean;
};

const checkpointTypes = new Set([
  "task.registered",
  "schema.registered",
  "run.started",
  "run.completed",
  "table.batch_published",
  "artifact.recorded",
  "agent.question_pending",
  "agent.question_answered",
]);

function objectValue(value: unknown): ObjectValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function turnIdFor(event: WorkbookEvent): string | null {
  const source = objectValue(event.payload.event);
  return textValue(event.payload.turn_id) ?? textValue(source?.turn_id);
}

function argumentsValue(call: ObjectValue): {
  value: unknown;
  raw: string | null;
} {
  const functionValue = objectValue(call.function);
  const raw = textValue(functionValue?.arguments);
  if (raw) {
    try {
      return { value: JSON.parse(raw), raw };
    } catch {
      return { value: raw, raw };
    }
  }
  return { value: call.input ?? call.arguments ?? {}, raw: null };
}

function actionFor(call: ObjectValue, args: unknown): string {
  const functionValue = objectValue(call.function);
  const name =
    textValue(functionValue?.name) ?? textValue(call.name) ?? "unknown";
  const input = objectValue(args);
  if (name === "call_tool" || name === "get_tool_info") {
    const server = textValue(input?.mcp_server);
    const tool = textValue(input?.tool_name);
    return [name, server, tool].filter(Boolean).join(":");
  }
  if (name === "exec") {
    const command = textValue(input?.command)?.trim();
    const executable = command
      ?.split(/\s+/)
      .find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token));
    return `${name}:${executable ?? "unknown"}`;
  }
  return name;
}

function isReadAction(action: string): boolean {
  if (
    [
      "get_workbook_context",
      "browser_snapshot",
      "browser_network_requests",
      "browser_network_request",
      "browser_find",
      "browser_tabs",
      "browser_console_messages",
    ].some((name) => action === name || action.endsWith(`:${name}`))
  ) {
    return true;
  }
  return ["cat", "ls", "pwd", "find", "rg", "grep", "head", "tail"].some(
    (name) => action === `exec:${name}`,
  );
}

function observationsFrom(event: WorkbookEvent): Observation[] {
  const source = objectValue(event.payload.event);
  const calls = source?.tool_calls;
  if (!Array.isArray(calls)) return [];
  const turnId = turnIdFor(event);
  return calls.flatMap((value) => {
    const call = objectValue(value);
    if (!call) return [];
    const args = argumentsValue(call);
    const functionValue = objectValue(call.function);
    const name =
      textValue(functionValue?.name) ?? textValue(call.name) ?? "unknown";
    const action = actionFor(call, args.value);
    const signature = createHash("sha256")
      .update(canonicalJson({ name, args: args.value ?? args.raw ?? null }))
      .digest("hex");
    return [
      {
        action,
        signature,
        seq: event.seq,
        turnId,
        read: isReadAction(action),
      },
    ];
  });
}

function failedToolResponse(event: WorkbookEvent): boolean {
  if (event.type !== "agent.tool.response") return false;
  const source = objectValue(event.payload.event);
  const content = textValue(source?.content);
  if (!content) return false;
  try {
    const parsed = objectValue(JSON.parse(content));
    if (!parsed) return false;
    if (parsed.success === false) return true;
    const response = objectValue(parsed.response);
    return typeof response?.exitCode === "number" && response.exitCode !== 0;
  } catch {
    return false;
  }
}

function repeatGroups(observations: Observation[]) {
  const groups: Array<{
    action: string;
    count: number;
    first_seq: number;
    last_seq: number;
    evidence: Array<{ seq: number; turn_id: string | null }>;
    read: boolean;
  }> = [];
  for (let index = 0; index < observations.length;) {
    const first = observations[index];
    if (!first) break;
    let end = index + 1;
    while (true) {
      const next = observations[end];
      if (!next || next.signature !== first.signature) break;
      end += 1;
    }
    if (end - index >= 2) {
      const values = observations.slice(index, end);
      groups.push({
        action: first.action,
        count: values.length,
        first_seq: first.seq,
        last_seq: values.at(-1)?.seq ?? first.seq,
        evidence: values.slice(0, 10).map((value) => ({
          seq: value.seq,
          turn_id: value.turnId,
        })),
        read: first.read,
      });
    }
    index = end;
  }
  return groups;
}

export function evaluateWorkbook(
  events: WorkbookEvent[],
  snapshot: WorkbookSnapshot,
) {
  const observations = events.flatMap(observationsFrom);
  const repeats = repeatGroups(observations);
  const failedToolEvents = events.filter(failedToolResponse);
  const failedResponses = failedToolEvents.length;
  const actionCounts = [
    ...observations.reduce((counts, value) => {
      counts.set(value.action, (counts.get(value.action) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()),
  ]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15)
    .map(([action, count]) => ({ action, count }));
  const turnIds = new Set(
    events.flatMap((event) => {
      if (event.type !== "agent.turn.created") return [];
      const turnId = turnIdFor(event);
      return turnId ? [turnId] : [];
    }),
  );
  const checkpoints = events
    .filter((event) => checkpointTypes.has(event.type))
    .map((event) => event.type);
  const terminalEvents = events.filter(
    (event) => event.type === "agent.turn.done",
  );
  const terminalStatus =
    textValue(
      objectValue(objectValue(terminalEvents.at(-1)?.payload.event)?.state)
        ?.status,
    ) ?? null;
  const findings: WorkbookEvaluation["findings"] = repeats
    .slice(0, 5)
    .map((repeat) => ({
      kind: "repetition" as const,
      message: `The agent repeated ${repeat.action} ${repeat.count} times consecutively; inspect whether the repeated calls produced progress.`,
      evidence: repeat.evidence,
    }));
  if (failedResponses > 0) {
    findings.push({
      kind: "tool_failure" as const,
      message: `${failedResponses} tool response(s) reported a failure or non-zero exit code.`,
      evidence: failedToolEvents.slice(0, 10).map((event) => ({
        seq: event.seq,
        turn_id: turnIdFor(event),
      })),
    });
  }
  const taskState = snapshot.tasks[0]?.state ?? null;
  const taskFinished = ["completed", "failed", "cancelled"].includes(
    taskState ?? "",
  );
  const latestTerminal = terminalEvents.at(-1);
  if (
    latestTerminal &&
    !taskFinished &&
    snapshot.pending_question === null &&
    terminalStatus === "done"
  ) {
    findings.push({
      kind: "incomplete" as const,
      message: `The latest turn ended while the task was '${taskState}', without a pending gate or a terminal task state.`,
      evidence: [
        { seq: latestTerminal.seq, turn_id: turnIdFor(latestTerminal) },
      ],
    });
  } else if (
    events.some((event) => event.type === "agent.turn.created") &&
    !terminalStatus
  ) {
    findings.push({
      kind: "incomplete" as const,
      message: "The workbook has turns but no recorded terminal turn status.",
      evidence: [],
    });
  }

  return WorkbookEvaluationSchema.parse({
    workbook_id: snapshot.workbook.id,
    event_count: events.length,
    turn_count: turnIds.size,
    tool_calls: {
      total: observations.length,
      unique_signatures: new Set(observations.map((value) => value.signature))
        .size,
      failed_responses: failedResponses,
      action_counts: actionCounts,
    },
    workflow: {
      task_state: taskState,
      checkpoints: [...new Set(checkpoints)],
      terminal_status: terminalStatus,
    },
    repetition: {
      consecutive: repeats
        .map(({ read: _read, ...repeat }) => repeat)
        .slice(0, 10),
      repeated_reads: repeats
        .filter((repeat) => repeat.read)
        .map(({ read: _read, ...repeat }) => repeat)
        .slice(0, 10),
    },
    findings: findings.slice(0, 10),
  });
}
