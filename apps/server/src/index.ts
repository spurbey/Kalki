import { serve } from "@hono/node-server";
import {
  ApiErrorResponseSchema,
  AnswerQuestionInputSchema,
  CreateTaskInputSchema,
  CreateTurnInputSchema,
  CreateWorkbookInputSchema,
  HealthResponseSchema,
  IdSchema,
  TableRowsQuerySchema,
  TableRowsResponseSchema,
  TaskResponseSchema,
  TrueForgeTurnResponseSchema,
  WorkbookResponseSchema,
  WorkbookHeartbeatSchema,
  WorkbookEvaluationResponseSchema,
  WorkbookSnapshotResponseSchema,
} from "@kalki/contracts";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { browserRoutes } from "./browser/routes.js";
import { config } from "./config.js";
import { openDatabase } from "./db/database.js";
import { DomainError } from "./domain/errors.js";
import { WorkbookService } from "./domain/workbookService.js";
import { evaluateWorkbook } from "./evaluation/agentEvaluator.js";
import { EventStore } from "./events/eventStore.js";
import { startWorkbookMcp } from "./mcp/workbookServer.js";
import { TrueForgeClient } from "./trueforge/sessionClient.js";
import { TurnMonitor } from "./trueforge/turnMonitor.js";
import type { TrueForgeTurnInput } from "@kalki/contracts";

const database = openDatabase(config.databasePath);
const workbooks = new WorkbookService(database);
const events = new EventStore(database);
const trueForge = new TrueForgeClient({
  baseUrl: config.trueForgeBaseUrl,
  model: config.agentModel,
  attachFrameworkSkill: config.attachFrameworkSkill,
  frameworkSkillName: config.frameworkSkillName,
});
const app = new Hono();
const connectingWorkbooks = new Set<string>();
const turningWorkbooks = new Set<string>();
const turns = new TurnMonitor(workbooks, events, trueForge);

turns.start();
startWorkbookMcp(workbooks);
app.route("/", browserRoutes);

function trueForgeUnavailable(error: unknown) {
  console.error(error);
  return new DomainError(
    "TrueForge is unavailable or not fully configured",
    "trueforge_unavailable",
    503,
    true,
  );
}

app.onError((error, c) => {
  if (error instanceof DomainError) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: error.code,
          message: error.message,
          path: [],
          details: {},
          retryable: error.retryable,
        },
      }),
      error.status,
    );
  }
  if (error instanceof SyntaxError) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Request body must be valid JSON",
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  console.error(error);
  return c.json(
    ApiErrorResponseSchema.parse({
      error: {
        code: "internal_error",
        message: "Unexpected server error",
        path: [],
        details: {},
        retryable: false,
      },
    }),
    500,
  );
});

app.get("/healthz", async (c) => {
  database.prepare("SELECT 1").get();
  return c.json(
    HealthResponseSchema.parse({
      ok: true,
      trueforge: await trueForge.health(),
    }),
  );
});

app.post("/api/v1/workbooks", async (c) => {
  const input = CreateWorkbookInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook input",
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  return c.json(
    WorkbookResponseSchema.parse({
      data: workbooks.createWorkbook(input.data),
    }),
    201,
  );
});

app.get("/api/v1/workbooks/:workbookId", async (c) => {
  const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook id",
          path: ["workbookId"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  try {
    await turns.refreshCurrent(workbookId.data);
  } catch (error) {
    console.error(error);
  }
  return c.json(
    WorkbookSnapshotResponseSchema.parse({
      data: workbooks.getSnapshot(workbookId.data),
    }),
  );
});

app.get("/api/v1/workbooks/:workbookId/events", (c) => {
  const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook id",
          path: ["workbookId"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  const workbook = workbooks.getWorkbook(workbookId.data);
  const currentTurn = workbooks.getCurrentTrueForgeTurn(workbook.id);
  if (workbook.trueforge_session_id && currentTurn?.status === "running") {
    turns.watch(workbook.id, workbook.trueforge_session_id, currentTurn.id);
  }

  const cursorValue =
    c.req.header("last-event-id") ?? c.req.query("after") ?? "0";
  const initialCursor = Number(cursorValue);
  if (!Number.isInteger(initialCursor) || initialCursor < 0) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Event cursor must be a non-negative integer",
          path: ["after"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }

  return streamSSE(c, async (stream) => {
    let cursor = initialCursor;
    if (cursor === 0) {
      const history = events.listHistory(workbookId.data);
      for (const event of history.events) {
        await stream.writeSSE({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(event),
        });
      }
      cursor = history.cursor;
      await stream.writeSSE({
        id: String(cursor),
        event: "heartbeat",
        data: JSON.stringify(WorkbookHeartbeatSchema.parse({ after: cursor })),
      });
    }
    while (!stream.aborted) {
      const available = events.listAfter(workbookId.data, cursor);
      for (const event of available) {
        await stream.writeSSE({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(event),
        });
        cursor = event.seq;
      }
      if (available.length === 0) {
        await stream.writeSSE({
          id: String(cursor),
          event: "heartbeat",
          data: JSON.stringify(
            WorkbookHeartbeatSchema.parse({ after: cursor }),
          ),
        });
      }
      await stream.sleep(1000);
    }
  });
});

app.get("/api/v1/workbooks/:workbookId/evaluation", (c) => {
  const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook id",
          path: ["workbookId"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  const snapshot = workbooks.getSnapshot(workbookId.data);
  return c.json(
    WorkbookEvaluationResponseSchema.parse({
      data: evaluateWorkbook(events.listHistory(workbookId.data).events, snapshot),
    }),
  );
});

app.get("/api/v1/tables/:tableId/rows", (c) => {
  const tableId = IdSchema.safeParse(c.req.param("tableId"));
  const query = TableRowsQuerySchema.safeParse(c.req.query());
  if (!tableId.success || !query.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid table row query",
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  return c.json(
    TableRowsResponseSchema.parse({
      data: workbooks.getTableRows(
        tableId.data,
        query.data.run_id,
        query.data.after,
        query.data.limit,
      ),
    }),
  );
});

app.post("/api/v1/workbooks/:workbookId/connect", async (c) => {
  const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook id",
          path: ["workbookId"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }

  if (connectingWorkbooks.has(workbookId.data)) {
    throw new DomainError(
      "Workbook connection is already in progress",
      "workbook_connection_in_progress",
      409,
      true,
    );
  }
  connectingWorkbooks.add(workbookId.data);

  try {
    const workbook = workbooks.getWorkbook(workbookId.data);
    if (workbook.trueforge_session_id) {
      return c.json(WorkbookResponseSchema.parse({ data: workbook }));
    }

    let sessionId: string;
    try {
      sessionId = await trueForge.createSession({
        id: workbook.id,
        title: workbook.title,
      });
    } catch (error) {
      throw trueForgeUnavailable(error);
    }

    try {
      return c.json(
        WorkbookResponseSchema.parse({
          data: workbooks.connectTrueForgeSession(workbookId.data, sessionId),
        }),
      );
    } catch (error) {
      try {
        await trueForge.deleteSession(sessionId);
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      throw error;
    }
  } finally {
    connectingWorkbooks.delete(workbookId.data);
  }
});

app.post("/api/v1/workbooks/:workbookId/tasks", async (c) => {
  const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook id",
          path: ["workbookId"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  const input = CreateTaskInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid task input",
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  return c.json(
    TaskResponseSchema.parse({
      data: workbooks.createTask(workbookId.data, input.data),
    }),
    201,
  );
});

app.post("/api/v1/workbooks/:workbookId/turns", async (c) => {
  const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid workbook id",
          path: ["workbookId"],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  const input = CreateTurnInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: "invalid_request",
          message: "Invalid turn input",
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }

  if (turningWorkbooks.has(workbookId.data)) {
    throw new DomainError(
      "A TrueForge turn request is already in progress",
      "turn_request_in_progress",
      409,
      true,
    );
  }
  turningWorkbooks.add(workbookId.data);

  try {
    const workbook = workbooks.getWorkbook(workbookId.data);
    if (!workbook.trueforge_session_id) {
      throw new DomainError(
        "Workbook is not connected to TrueForge",
        "workbook_not_connected",
        409,
      );
    }
    if (workbooks.getSnapshot(workbook.id).tasks.length === 0) {
      throw new DomainError(
        "Create a task before sending a message",
        "task_required",
        409,
      );
    }

    let current = workbooks.getCurrentTrueForgeTurn(workbook.id);
    if (current?.status === "running") {
      try {
        const refreshed = await trueForge.getTurn(
          workbook.trueforge_session_id,
          current.id,
        );
        current = workbooks.saveTrueForgeTurn(workbook.id, refreshed);
        await turns.recordPendingQuestion(workbook.id, refreshed);
      } catch (error) {
        throw trueForgeUnavailable(error);
      }
      if (current.status === "running") {
        throw new DomainError(
          "A TrueForge turn is already running",
          "turn_already_running",
          409,
          true,
        );
      }
    }

    let turn;
    try {
      turn = await trueForge.createTurn(
        workbook.trueforge_session_id,
        input.data.input,
      );
    } catch (error) {
      throw trueForgeUnavailable(error);
    }

    try {
      const savedTurn = workbooks.saveTrueForgeTurn(workbook.id, turn);
      turns.watch(workbook.id, workbook.trueforge_session_id, savedTurn.id);
      await turns.recordPendingQuestion(workbook.id, turn);
      return c.json(
        TrueForgeTurnResponseSchema.parse({
          data: savedTurn,
        }),
      );
    } catch (error) {
      try {
        await trueForge.cancelSession(workbook.trueforge_session_id);
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      throw error;
    }
  } finally {
    turningWorkbooks.delete(workbookId.data);
  }
});

app.post(
  "/api/v1/workbooks/:workbookId/questions/:toolCallId/answer",
  async (c) => {
    const workbookId = IdSchema.safeParse(c.req.param("workbookId"));
    const toolCallId = IdSchema.safeParse(c.req.param("toolCallId"));
    if (!workbookId.success || !toolCallId.success) {
      return c.json(
        ApiErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid workbook or tool call id",
            path: [],
            details: {},
            retryable: false,
          },
        }),
        400,
      );
    }

    const input = AnswerQuestionInputSchema.safeParse(await c.req.json());
    if (!input.success) {
      return c.json(
        ApiErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid question answer",
            path: [],
            details: {},
            retryable: false,
          },
        }),
        400,
      );
    }

    const workbook = workbooks.getWorkbook(workbookId.data);
    if (!workbook.trueforge_session_id) {
      throw new DomainError(
        "Workbook is not connected to TrueForge",
        "workbook_not_connected",
        409,
      );
    }
    try {
      await turns.refreshCurrent(workbook.id);
    } catch (error) {
      throw trueForgeUnavailable(error);
    }

    const pending = workbooks.getPendingQuestion(workbook.id);
    if (!pending || pending.tool_call_id !== toolCallId.data) {
      throw new DomainError(
        "The requested question is not pending",
        "question_not_found",
        404,
      );
    }

    workbooks.markQuestionSubmitting(workbook.id, toolCallId.data, input.data);
    let answerTurn: TrueForgeTurnInput;
    try {
      answerTurn = await trueForge.answerQuestion(
        workbook.trueforge_session_id,
        {
          threadId: pending.thread_id,
          toolCallId: pending.tool_call_id,
          content: input.data.answer,
        },
      );
    } catch (error) {
      workbooks.resetQuestionSubmission(workbook.id, toolCallId.data);
      throw trueForgeUnavailable(error);
    }

    try {
      const savedTurn = workbooks.saveTrueForgeTurn(workbook.id, answerTurn);
      workbooks.completeQuestion(
        workbook.id,
        toolCallId.data,
        input.data,
        answerTurn.id,
      );
      turns.watch(workbook.id, workbook.trueforge_session_id, savedTurn.id);
    } catch (error) {
      workbooks.resetQuestionSubmission(workbook.id, toolCallId.data);
      throw error;
    }

    return c.json(
      WorkbookSnapshotResponseSchema.parse({
        data: workbooks.getSnapshot(workbook.id),
      }),
    );
  },
);

serve(
  {
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: config.serverPort,
  },
  (info) =>
    console.log(`Kalki API listening on http://${info.address}:${info.port}`),
);
