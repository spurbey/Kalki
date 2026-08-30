import { serve } from '@hono/node-server';
import {
  ApiErrorResponseSchema,
  AnswerQuestionInputSchema,
  CreateTaskInputSchema,
  CreateTurnInputSchema,
  CreateWorkbookInputSchema,
  HealthResponseSchema,
  IdSchema,
  type JsonObject,
  type JsonValue,
  TaskResponseSchema,
  type TrueForgeStreamEvent,
  TrueForgeTurnResponseSchema,
  WorkbookResponseSchema,
  WorkbookSnapshotResponseSchema,
} from '@kalki/contracts';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { DomainError } from './domain/errors.js';
import { WorkbookService } from './domain/workbookService.js';
import { EventStore } from './events/eventStore.js';
import { startWorkbookMcp } from './mcp/workbookServer.js';
import {
  TrueForgeClient,
  type PendingTrueForgeQuestion,
} from './trueforge/sessionClient.js';
import type { TrueForgeTurnInput } from '@kalki/contracts';

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
const streamingTurns = new Set<string>();

startWorkbookMcp(workbooks);

function trueForgeUnavailable(error: unknown) {
  console.error(error);
  return new DomainError('TrueForge is unavailable or not fully configured', 'trueforge_unavailable', 503, true);
}

function gateKindForTaskState(state: string): PendingQuestionRegistration['gateKind'] {
  if (state === 'awaiting_task_confirmation') return 'task_review';
  if (state === 'awaiting_schema_review') return 'schema_review';
  if (state === 'awaiting_production_confirmation') return 'production_review';
  return 'clarification';
}

type PendingQuestionRegistration = {
  taskId: string | null;
  runId: string | null;
  gateKind: 'clarification' | 'task_review' | 'schema_review' | 'production_review' | 'skill_promotion_review';
  questionTurnId: string;
  questionEventId: string;
  toolCallId: string;
  threadId: string;
  questionText: string;
  options: string[];
};

async function persistPendingQuestion(workbookId: string, turn: TrueForgeTurnInput) {
  const question: PendingTrueForgeQuestion | null = await trueForge.getPendingQuestion(
    workbooks.getWorkbook(workbookId).trueforge_session_id!,
    turn,
  );
  if (!question) return null;

  const snapshot = workbooks.getSnapshot(workbookId);
  if (snapshot.tasks.length > 1) {
    throw new DomainError('Cannot match the question to one task', 'ambiguous_question_task', 409);
  }
  const task = snapshot.tasks[0] ?? null;
  const run = snapshot.runs.find((candidate) => candidate.status === 'awaiting_confirmation') ?? null;

  return workbooks.savePendingQuestion(workbookId, {
    taskId: task?.id ?? null,
    runId: run?.id ?? null,
    gateKind: gateKindForTaskState(task?.state ?? 'aligning'),
    questionTurnId: question.questionTurnId,
    questionEventId: question.questionEventId,
    toolCallId: question.toolCallId,
    threadId: question.threadId,
    questionText: question.question,
    options: question.options,
  });
}

function compactAgentEvent(event: TrueForgeStreamEvent): JsonObject {
  const compact = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return value.slice(0, 4000);
    if (Array.isArray(value)) return value.slice(0, 50).map(compact);
    if (value && typeof value === 'object') {
      const result: JsonObject = {};
      for (const [key, child] of Object.entries(value).slice(0, 50)) {
        const normalized = key.toLowerCase();
        if (normalized.includes('reasoning') || normalized === 'usage' || normalized === 'metrics') continue;
        result[key] = compact(child);
      }
      return result;
    }
    return value;
  };

  const payload = compact(event) as JsonObject;
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 16_384) return payload;

  const fallback: JsonObject = { type: event.type.slice(0, 94), payload_truncated: true };
  for (const key of ['id', 'thread_id', 'created_at', 'content']) {
    if (typeof event[key] === 'string') fallback[key] = event[key].slice(0, 4000);
  }
  return fallback;
}

function startTurnStream(workbookId: string, sessionId: string, turnId: string) {
  if (streamingTurns.has(turnId)) return;
  streamingTurns.add(turnId);

  void (async () => {
    try {
      const stored = workbooks.getCurrentTrueForgeTurn(workbookId);
      const after = stored?.id === turnId ? stored.last_sequence_number : 0;
      await trueForge.subscribeToTurn(sessionId, turnId, after, async (event, sequenceNumber) => {
        events.appendTurnEvent(workbookId, turnId, sequenceNumber, `agent.${event.type}`, {
          turn_id: turnId,
          upstream_sequence: sequenceNumber,
          event: compactAgentEvent(event),
        });
      });

      const completed = await trueForge.getTurn(sessionId, turnId);
      workbooks.saveTrueForgeTurn(workbookId, completed);
      await persistPendingQuestion(workbookId, completed);
    } catch (error) {
      console.error(`TrueForge event stream failed for turn ${turnId}`, error);
    } finally {
      streamingTurns.delete(turnId);
    }
  })();
}

async function refreshCurrentTurn(workbookId: string) {
  const workbook = workbooks.getWorkbook(workbookId);
  if (!workbook.trueforge_session_id) return;
  const current = workbooks.getCurrentTrueForgeTurn(workbookId);
  if (!current || (current.status !== 'running' && current.required_actions.length === 0)) return;

  if (current.status === 'running') {
    startTurnStream(workbookId, workbook.trueforge_session_id, current.id);
  }

  const upstream = await trueForge.getTurn(workbook.trueforge_session_id, current.id);
  workbooks.saveTrueForgeTurn(workbookId, upstream);
  await persistPendingQuestion(workbookId, upstream);
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
          code: 'invalid_request',
          message: 'Request body must be valid JSON',
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
        code: 'internal_error',
        message: 'Unexpected server error',
        path: [],
        details: {},
        retryable: false,
      },
    }),
    500,
  );
});

app.get('/healthz', async c => {
  database.prepare('SELECT 1').get();
  return c.json(
    HealthResponseSchema.parse({
      ok: true,
      trueforge: await trueForge.health(),
    }),
  );
});

app.post('/api/v1/workbooks', async c => {
  const input = CreateWorkbookInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook input',
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  return c.json(WorkbookResponseSchema.parse({ data: workbooks.createWorkbook(input.data) }), 201);
});

app.get('/api/v1/workbooks/:workbookId', async c => {
  const workbookId = IdSchema.safeParse(c.req.param('workbookId'));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook id',
          path: ['workbookId'],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  try {
    await refreshCurrentTurn(workbookId.data);
  } catch (error) {
    console.error(error);
  }
  return c.json(WorkbookSnapshotResponseSchema.parse({ data: workbooks.getSnapshot(workbookId.data) }));
});

app.get('/api/v1/workbooks/:workbookId/events', c => {
  const workbookId = IdSchema.safeParse(c.req.param('workbookId'));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook id',
          path: ['workbookId'],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  const workbook = workbooks.getWorkbook(workbookId.data);
  const currentTurn = workbooks.getCurrentTrueForgeTurn(workbook.id);
  if (workbook.trueforge_session_id && currentTurn?.status === 'running') {
    startTurnStream(workbook.id, workbook.trueforge_session_id, currentTurn.id);
  }

  const cursorValue = c.req.header('last-event-id') ?? c.req.query('after') ?? '0';
  const initialCursor = Number(cursorValue);
  if (!Number.isInteger(initialCursor) || initialCursor < 0) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Event cursor must be a non-negative integer',
          path: ['after'],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }

  return streamSSE(c, async stream => {
    let cursor = initialCursor;
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
          event: 'heartbeat',
          data: JSON.stringify({ after: cursor }),
        });
      }
      await stream.sleep(1000);
    }
  });
});

app.post('/api/v1/workbooks/:workbookId/connect', async c => {
  const workbookId = IdSchema.safeParse(c.req.param('workbookId'));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook id',
          path: ['workbookId'],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }

  if (connectingWorkbooks.has(workbookId.data)) {
    throw new DomainError('Workbook connection is already in progress', 'workbook_connection_in_progress', 409, true);
  }
  connectingWorkbooks.add(workbookId.data);

  try {
    const workbook = workbooks.getWorkbook(workbookId.data);
    if (workbook.trueforge_session_id) {
      return c.json(WorkbookResponseSchema.parse({ data: workbook }));
    }

    let sessionId: string;
    try {
      sessionId = await trueForge.createSession();
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

app.post('/api/v1/workbooks/:workbookId/tasks', async c => {
  const workbookId = IdSchema.safeParse(c.req.param('workbookId'));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook id',
          path: ['workbookId'],
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
          code: 'invalid_request',
          message: 'Invalid task input',
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }
  return c.json(
    TaskResponseSchema.parse({ data: workbooks.createTask(workbookId.data, input.data) }),
    201,
  );
});

app.post('/api/v1/workbooks/:workbookId/turns', async c => {
  const workbookId = IdSchema.safeParse(c.req.param('workbookId'));
  if (!workbookId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook id',
          path: ['workbookId'],
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
          code: 'invalid_request',
          message: 'Invalid turn input',
          path: [],
          details: {},
          retryable: false,
        },
      }),
      400,
    );
  }

  if (turningWorkbooks.has(workbookId.data)) {
    throw new DomainError('A TrueForge turn request is already in progress', 'turn_request_in_progress', 409, true);
  }
  turningWorkbooks.add(workbookId.data);

  try {
    const workbook = workbooks.getWorkbook(workbookId.data);
    if (!workbook.trueforge_session_id) {
      throw new DomainError('Workbook is not connected to TrueForge', 'workbook_not_connected', 409);
    }

    let current = workbooks.getCurrentTrueForgeTurn(workbook.id);
    if (current?.status === 'running') {
      try {
        const refreshed = await trueForge.getTurn(workbook.trueforge_session_id, current.id);
        current = workbooks.saveTrueForgeTurn(workbook.id, refreshed);
        await persistPendingQuestion(workbook.id, refreshed);
      } catch (error) {
        throw trueForgeUnavailable(error);
      }
      if (current.status === 'running') {
        throw new DomainError('A TrueForge turn is already running', 'turn_already_running', 409, true);
      }
    }

    let turn;
    try {
      turn = await trueForge.createTurn(workbook.trueforge_session_id, input.data.input);
    } catch (error) {
      throw trueForgeUnavailable(error);
    }

    try {
      const savedTurn = workbooks.saveTrueForgeTurn(workbook.id, turn);
      startTurnStream(workbook.id, workbook.trueforge_session_id, savedTurn.id);
      await persistPendingQuestion(workbook.id, turn);
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

app.post('/api/v1/workbooks/:workbookId/questions/:toolCallId/answer', async c => {
  const workbookId = IdSchema.safeParse(c.req.param('workbookId'));
  const toolCallId = IdSchema.safeParse(c.req.param('toolCallId'));
  if (!workbookId.success || !toolCallId.success) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'invalid_request',
          message: 'Invalid workbook or tool call id',
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
          code: 'invalid_request',
          message: 'Invalid question answer',
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
    throw new DomainError('Workbook is not connected to TrueForge', 'workbook_not_connected', 409);
  }
  try {
    await refreshCurrentTurn(workbook.id);
  } catch (error) {
    throw trueForgeUnavailable(error);
  }

  const pending = workbooks.getPendingQuestion(workbook.id);
  if (!pending || pending.tool_call_id !== toolCallId.data) {
    throw new DomainError('The requested question is not pending', 'question_not_found', 404);
  }

  workbooks.markQuestionSubmitting(workbook.id, toolCallId.data, input.data);
  let answerTurn: TrueForgeTurnInput;
  try {
    answerTurn = await trueForge.answerQuestion(workbook.trueforge_session_id, {
      threadId: pending.thread_id,
      toolCallId: pending.tool_call_id,
      content: input.data.answer,
    });
  } catch (error) {
    workbooks.resetQuestionSubmission(workbook.id, toolCallId.data);
    throw trueForgeUnavailable(error);
  }

  try {
    const savedTurn = workbooks.saveTrueForgeTurn(workbook.id, answerTurn);
    workbooks.completeQuestion(workbook.id, toolCallId.data, input.data, answerTurn.id);
    startTurnStream(workbook.id, workbook.trueforge_session_id, savedTurn.id);
  } catch (error) {
    workbooks.resetQuestionSubmission(workbook.id, toolCallId.data);
    throw error;
  }

  return c.json(WorkbookSnapshotResponseSchema.parse({ data: workbooks.getSnapshot(workbook.id) }));
});

serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.serverPort,
  },
  info => console.log(`Kalki API listening on http://${info.address}:${info.port}`),
);
