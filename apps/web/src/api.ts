import {
  ApiErrorResponseSchema,
  HealthResponseSchema,
  BrowserNavigateInputSchema,
  BrowserStatusResponseSchema,
  TableRowsResponseSchema,
  TaskResponseSchema,
  TrueForgeTurnResponseSchema,
  WorkbookEventSchema,
  WorkbookResponseSchema,
  WorkbookSnapshotResponseSchema,
  type AgentQuestion,
  type AnswerQuestionInput,
  type BrowserNavigateInput,
  type BrowserStatus,
  type CreateTurnInput,
  type CreateWorkbookInput,
  type CreateTaskInput,
  type HealthResponse,
  type TableRowsResponse,
  type Task,
  type TrueForgeTurn,
  type Workbook,
  type WorkbookEvent,
  type WorkbookSnapshot,
} from "@kalki/contracts";

type Parser<T> = { parse(value: unknown): T };

export class KalkiApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  schema: Parser<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = ApiErrorResponseSchema.safeParse(body);
    throw new KalkiApiError(
      parsed.success
        ? parsed.data.error.message
        : `Request failed (${response.status})`,
      parsed.success && parsed.data.error.retryable,
    );
  }

  return schema.parse(body);
}

export async function getHealth(): Promise<HealthResponse> {
  return request("/healthz", HealthResponseSchema);
}

export async function getBrowserStatus(): Promise<BrowserStatus> {
  const response = await request(
    "/api/v1/browser/status",
    BrowserStatusResponseSchema,
  );
  return response.data;
}

export async function navigateBrowser(
  input: BrowserNavigateInput,
): Promise<BrowserStatus> {
  const response = await request(
    "/api/v1/browser/navigate",
    BrowserStatusResponseSchema,
    {
      method: "POST",
      body: JSON.stringify(BrowserNavigateInputSchema.parse(input)),
    },
  );
  return response.data;
}

export function browserScreenshotUrl(version: number): string {
  return `/api/v1/browser/screenshot?v=${version}`;
}

export async function createWorkbook(
  input: CreateWorkbookInput,
): Promise<Workbook> {
  const response = await request("/api/v1/workbooks", WorkbookResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.data;
}

export async function getWorkbook(
  workbookId: string,
): Promise<WorkbookSnapshot> {
  const response = await request(
    `/api/v1/workbooks/${encodeURIComponent(workbookId)}`,
    WorkbookSnapshotResponseSchema,
  );
  return response.data;
}

export async function createTask(
  workbookId: string,
  input: CreateTaskInput,
): Promise<Task> {
  const response = await request(
    `/api/v1/workbooks/${encodeURIComponent(workbookId)}/tasks`,
    TaskResponseSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.data;
}

export async function connectWorkbook(workbookId: string): Promise<Workbook> {
  const response = await request(
    `/api/v1/workbooks/${encodeURIComponent(workbookId)}/connect`,
    WorkbookResponseSchema,
    { method: "POST" },
  );
  return response.data;
}

export async function createTurn(
  workbookId: string,
  input: CreateTurnInput,
): Promise<TrueForgeTurn> {
  const response = await request(
    `/api/v1/workbooks/${encodeURIComponent(workbookId)}/turns`,
    TrueForgeTurnResponseSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.data;
}

export async function answerQuestion(
  workbookId: string,
  question: AgentQuestion,
  answer: string,
  decision: AnswerQuestionInput["decision"],
): Promise<WorkbookSnapshot> {
  const input: AnswerQuestionInput = {
    question_event_id: question.question_event_id,
    question_turn_id: question.question_turn_id,
    thread_id: question.thread_id,
    answer,
    decision,
    gate_kind: question.gate_kind,
    ...(question.gate_kind === "production_review" && question.run_id
      ? { related_run_id: question.run_id }
      : {}),
  };
  const response = await request(
    `/api/v1/workbooks/${encodeURIComponent(workbookId)}/questions/${encodeURIComponent(question.tool_call_id)}/answer`,
    WorkbookSnapshotResponseSchema,
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.data;
}

export async function getTableRows(
  tableId: string,
  runId: string,
  after?: string,
): Promise<TableRowsResponse["data"]> {
  const query = new URLSearchParams({ run_id: runId, limit: "50" });
  if (after) query.set("after", after);
  const response = await request(
    `/api/v1/tables/${encodeURIComponent(tableId)}/rows?${query.toString()}`,
    TableRowsResponseSchema,
  );
  return response.data;
}

const streamedEventTypes = [
  "agent.turn.created",
  "agent.model.message",
  "agent.model.message.delta",
  "agent.tool.response",
  "agent.tool.approval_required",
  "agent.tool.response_required",
  "agent.mcp.auth_required",
  "agent.mcp.initialize",
  "agent.sandbox.created",
  "agent.thread.created",
  "agent.thread.done",
  "agent.turn.done",
  "table.batch_published",
] as const;

export type StreamStatus = "connecting" | "live" | "reconnecting";

export function subscribeWorkbookEvents(
  workbookId: string,
  onEvent: (event: WorkbookEvent) => void,
  onStatus: (status: StreamStatus) => void,
): () => void {
  onStatus("connecting");
  const source = new EventSource(
    `/api/v1/workbooks/${encodeURIComponent(workbookId)}/events?after=0`,
  );
  const handle = (message: Event) => {
    if (!(message instanceof MessageEvent)) return;
    const parsed = WorkbookEventSchema.safeParse(JSON.parse(message.data));
    if (parsed.success) onEvent(parsed.data);
  };

  for (const type of streamedEventTypes) source.addEventListener(type, handle);
  source.addEventListener("message", handle);
  source.onopen = () => onStatus("live");
  source.onerror = () => onStatus("reconnecting");

  return () => source.close();
}
