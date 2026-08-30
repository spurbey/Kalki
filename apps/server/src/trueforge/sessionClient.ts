const coordinatorInstructions = [
  "You are the Kalki workbook coordinator.",
  "Read the framework skill before authoring task files or workflow code.",
  "Use workbook MCP for every durable product change.",
  "Use ask_user_question for task, schema, production, and skill-promotion review.",
  "Never treat silence, timeout, tool approval, or auto-continue as user consent.",
  "Keep raw rows in files and return compact manifests only.",
  "Resolve task paths from the current working directory.",
].join("\n");

export type TrueForgeTurnStatus = "running" | "done" | "cancelled" | "error";

export interface TrueForgeTurn {
  id: string;
  sessionId: string;
  previousTurnId: string | null;
  status: TrueForgeTurnStatus;
  requiredActions: unknown[];
  createdAt: string;
  finishedAt: string | null;
}

interface TrueForgeClientOptions {
  baseUrl: string;
  model: string;
  attachFrameworkSkill: boolean;
  frameworkSkillName: string;
}

export class TrueForgeClient {
  constructor(private readonly options: TrueForgeClientOptions) {}

  async health(): Promise<boolean> {
    try {
      return (await fetch(`${this.options.baseUrl}/healthz`)).ok;
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
    });
    const payload = await this.readJson(response, "session creation");
    const id = this.data(payload).id;
    if (typeof id !== "string" || !id)
      throw new Error("TrueForge session response did not include an id");
    return id;
  }

  async createTurn(sessionId: string, input: string): Promise<TrueForgeTurn> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: [{ type: "user.message", content: input }],
          previous_turn_id: "auto",
          stream: false,
        }),
      },
    );
    return this.parseTurn(await this.readJson(response, "turn creation"));
  }

  async getTurn(sessionId: string, turnId: string): Promise<TrueForgeTurn> {
    const response = await fetch(
      `${this.options.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    );
    return this.parseTurn(await this.readJson(response, "turn read"));
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

  private parseTurn(payload: unknown): TrueForgeTurn {
    const turn = this.data(payload);
    const state = turn.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("TrueForge turn response did not include state");
    }
    const turnState = state as Record<string, unknown>;
    const status = turnState.status;
    if (!["running", "done", "cancelled", "error"].includes(String(status))) {
      throw new Error("TrueForge turn response included an invalid status");
    }
    if (
      typeof turn.id !== "string" ||
      typeof turn.session_id !== "string" ||
      typeof turn.created_at !== "string"
    ) {
      throw new Error("TrueForge turn response was missing required fields");
    }

    return {
      id: turn.id,
      sessionId: turn.session_id,
      previousTurnId:
        typeof turn.previous_turn_id === "string"
          ? turn.previous_turn_id
          : null,
      status: status as TrueForgeTurnStatus,
      requiredActions: Array.isArray(turnState.required_actions)
        ? turnState.required_actions
        : [],
      createdAt: turn.created_at,
      finishedAt:
        typeof turnState.completed_at === "string"
          ? turnState.completed_at
          : null,
    };
  }
}
