import {
  IdSchema,
  type JsonObject,
  type TrueForgeTurnInput,
  TrueForgeTurnInputSchema,
} from "@kalki/contracts";

const coordinatorInstructions = [
  "You are the Kalki workbook coordinator.",
  "Read the framework skill before authoring task files or workflow code.",
  "Use workbook MCP for every durable product change.",
  "Use ask_user_question for task, schema, production, and skill-promotion review.",
  "Never treat silence, timeout, tool approval, or auto-continue as user consent.",
  "Keep raw rows in files and return compact manifests only.",
  "Resolve task paths from the current working directory.",
].join("\n");

const healthTimeoutMs = 3_000;
const requestTimeoutMs = 30_000;

interface TrueForgeClientOptions {
  baseUrl: string;
  model: string;
  attachFrameworkSkill: boolean;
  frameworkSkillName: string;
}

export interface PendingTrueForgeQuestion {
  questionEventId: string;
  questionTurnId: string;
  threadId: string;
  toolCallId: string;
  question: string;
  options: string[];
}

export type TrueForgeStreamEvent = JsonObject & { type: string };

export class TrueForgeClient {
  constructor(private readonly options: TrueForgeClientOptions) {}

  async health(): Promise<boolean> {
    try {
      return (
        await fetch(`${this.options.baseUrl}/healthz`, {
          signal: AbortSignal.timeout(healthTimeoutMs),
        })
      ).ok;
    } catch {
      return false;
    }
  }

  async createSession(): Promise<string> {
    if (!this.options.model) throw new Error("KALKI_AGENT_MODEL must be set");

    const spec = {
      model: { name: this.options.model },
      instructions: coordinatorInstructions,
      mcp_servers: [
        {
          name: "kalki-workbook",
          enable_tools: ["@all"],
          disable_tools: [],
          preload_tools: [],
          require_approval_for_tools: [],
          preload: true,
        },
        {
          name: "playwright",
          enable_tools: ["@all"],
          disable_tools: [],
          preload_tools: [],
          require_approval_for_tools: [],
          preload: false,
        },
      ],
      ...(this.options.attachFrameworkSkill
        ? { skills: [{ name: this.options.frameworkSkillName }] }
        : {}),
      config: {
        iteration_limit: 100,
        sandbox: { enabled: true, file_downloads: true },
        dynamic_sub_agents: { enabled: true },
        context_management: {
          compaction: { enabled: true },
          large_tool_response: { enabled: true },
        },
        generative_ui: { enabled: true },
        ask_user_questions: { enabled: true },
      },
    };

    const response = await fetch(`${this.options.baseUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { spec } }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const payload = await this.readJson(response, "session creation");
    return IdSchema.parse(this.data(payload).id);
  }

  async createTurn(
    sessionId: string,
    input: string,
  ): Promise<TrueForgeTurnInput> {
    return this.createTurnWithInput(sessionId, [
      { type: "user.message", content: input },
    ]);
  }

  async answerQuestion(
    sessionId: string,
    input: { threadId: string; toolCallId: string; content: string },
  ): Promise<TrueForgeTurnInput> {
    return this.createTurnWithInput(sessionId, [
      {
        type: "user.tool_response",
        thread_id: input.threadId,
        tool_call_id: input.toolCallId,
        content: input.content,
      },
    ]);
  }

  async subscribeToTurn(
    sessionId: string,
    turnId: string,
    afterSequenceNumber: number,
    onEvent: (event: TrueForgeStreamEvent, sequenceNumber: number) => Promise<void>,
  ): Promise<void> {
    let cursor = afterSequenceNumber;

    while (true) {
      const response = await fetch(
        `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/subscribe?after_sequence_number=${cursor}`,
        { headers: { accept: "text/event-stream" } },
      );
      if (!response.ok || !response.body) {
        throw new Error(
          `TrueForge turn subscription failed (${response.status}): ${(await response.text()).slice(0, 1000)}`,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventId = "";
      let dataLines: string[] = [];
      let turnDone = false;

      const emit = async () => {
        if (dataLines.length === 0) return;
        const sequenceNumber = Number(eventId);
        if (!Number.isInteger(sequenceNumber) || sequenceNumber <= cursor) {
          throw new Error("TrueForge turn stream returned an invalid sequence id");
        }
        const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        if (typeof parsed.type !== "string") {
          throw new Error("TrueForge turn stream returned an invalid event");
        }
        await onEvent(parsed as TrueForgeStreamEvent, sequenceNumber);
        cursor = sequenceNumber;
        turnDone = parsed.type === "turn.done";
      };

      while (!turnDone) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            await emit();
            eventId = "";
            dataLines = [];
          } else if (line.startsWith("id:")) {
            eventId = line.slice(3).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
          newline = buffer.indexOf("\n");
        }
      }

      reader.releaseLock();
      if (turnDone) return;
    }
  }

  async getPendingQuestion(
    sessionId: string,
    turn: TrueForgeTurnInput,
  ): Promise<PendingTrueForgeQuestion | null> {
    const action = turn.requiredActions.find((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      return (value as Record<string, unknown>).type === "tool.response_required";
    });
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return null;
    }

    const required = action as Record<string, unknown>;
    const questionEventId = IdSchema.parse(required.id);
    const threadId = IdSchema.parse(required.thread_id);
    const refs = required.tool_calls;
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new Error("TrueForge question action did not include a tool call");
    }

    const ref = refs[0];
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new Error("TrueForge question action included an invalid tool call");
    }
    const toolCall = ref as Record<string, unknown>;
    const toolCallId = IdSchema.parse(toolCall.id);
    const sourceEventId = IdSchema.parse(toolCall.source_event_id);
    const events = await this.listTurnEvents(sessionId, turn.id);
    const source = events.find((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      return (value as Record<string, unknown>).id === sourceEventId;
    });
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("TrueForge question source event was not found");
    }

    const calls = (source as Record<string, unknown>).tool_calls;
    const call = Array.isArray(calls)
      ? calls.find((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return false;
          }
          return (value as Record<string, unknown>).id === toolCallId;
        })
      : null;
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new Error("TrueForge question tool call was not found");
    }

    const callInfo = call as Record<string, unknown>;
    const toolInfo = callInfo.tool_info;
    const functionCall = callInfo.function;
    if (
      !toolInfo ||
      typeof toolInfo !== "object" ||
      Array.isArray(toolInfo) ||
      (toolInfo as Record<string, unknown>).name !== "ask_user_question" ||
      !functionCall ||
      typeof functionCall !== "object" ||
      Array.isArray(functionCall)
    ) {
      throw new Error("TrueForge required action was not an ask_user_question call");
    }

    const rawArguments = (functionCall as Record<string, unknown>).arguments;
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(String(rawArguments ?? "{}"));
    } catch {
      throw new Error("TrueForge question arguments were not valid JSON");
    }
    if (
      !argumentsValue ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue)
    ) {
      throw new Error("TrueForge question arguments were invalid");
    }
    const questionValue = argumentsValue as Record<string, unknown>;
    const question = questionValue.question;
    const options = questionValue.options;
    if (
      typeof question !== "string" ||
      !question.trim() ||
      !Array.isArray(options) ||
      options.some((value) => typeof value !== "string")
    ) {
      throw new Error("TrueForge question arguments were missing question options");
    }

    return {
      questionEventId,
      questionTurnId: turn.id,
      threadId,
      toolCallId,
      question: question.trim(),
      options: options as string[],
    };
  }

  private async createTurnWithInput(
    sessionId: string,
    input: unknown[],
  ): Promise<TrueForgeTurnInput> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input,
          previous_turn_id: "auto",
          stream: false,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    );
    return this.parseTurn(await this.readJson(response, "turn creation"));
  }

  private async listTurnEvents(
    sessionId: string,
    turnId: string,
  ): Promise<unknown[]> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events?limit=100&order=asc`,
      { signal: AbortSignal.timeout(requestTimeoutMs) },
    );
    const payload = await this.readJson(response, "turn event list");
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new Error("TrueForge event response did not include data");
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new Error("TrueForge event response data was invalid");
    }
    return data;
  }

  async getTurn(
    sessionId: string,
    turnId: string,
  ): Promise<TrueForgeTurnInput> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      { signal: AbortSignal.timeout(requestTimeoutMs) },
    );
    return this.parseTurn(await this.readJson(response, "turn read"));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal: AbortSignal.timeout(requestTimeoutMs) },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `TrueForge session cleanup failed (${response.status}): ${(await response.text()).slice(0, 1000)}`,
      );
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST", signal: AbortSignal.timeout(requestTimeoutMs) },
    );
    if (!response.ok) {
      throw new Error(
        `TrueForge session cancellation failed (${response.status}): ${(await response.text()).slice(0, 1000)}`,
      );
    }
  }

  private async readJson(
    response: Response,
    operation: string,
  ): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `TrueForge ${operation} failed (${response.status}): ${text.slice(0, 1000)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`TrueForge ${operation} returned invalid JSON`);
    }
  }

  private data(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new Error("TrueForge response did not include data");
    }
    const data = payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("TrueForge response data was invalid");
    }
    return data as Record<string, unknown>;
  }

  private parseTurn(payload: unknown): TrueForgeTurnInput {
    const turn = this.data(payload);
    const state = turn.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("TrueForge turn response did not include state");
    }
    const turnState = state as Record<string, unknown>;
    return TrueForgeTurnInputSchema.parse({
      id: turn.id,
      sessionId: turn.session_id,
      previousTurnId:
        typeof turn.previous_turn_id === "string"
          ? turn.previous_turn_id
          : null,
      status: turnState.status,
      requiredActions: Array.isArray(turnState.required_actions)
        ? turnState.required_actions
        : [],
      createdAt: turn.created_at,
      finishedAt:
        typeof turnState.completed_at === "string"
          ? turnState.completed_at
          : null,
    });
  }
}
