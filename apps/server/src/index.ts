import { serve } from '@hono/node-server';
import {
  ApiErrorResponseSchema,
  CreateTaskInputSchema,
  CreateTurnInputSchema,
  CreateWorkbookInputSchema,
  HealthResponseSchema,
  IdSchema,
  TaskResponseSchema,
  TrueForgeTurnResponseSchema,
  WorkbookResponseSchema,
  WorkbookSnapshotResponseSchema,
} from '@kalki/contracts';
import { Hono } from 'hono';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { DomainError } from './domain/errors.js';
import { WorkbookService } from './domain/workbookService.js';
import { TrueForgeClient } from './trueforge/sessionClient.js';

const database = openDatabase(config.databasePath);
const workbooks = new WorkbookService(database);
const trueForge = new TrueForgeClient({
  baseUrl: config.trueForgeBaseUrl,
  model: config.agentModel,
  attachFrameworkSkill: config.attachFrameworkSkill,
  frameworkSkillName: config.frameworkSkillName,
});
const app = new Hono();

function trueForgeUnavailable(error: unknown) {
  console.error(error);
  return new DomainError('TrueForge is unavailable or not fully configured', 'trueforge_unavailable', 503, true);
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

app.get('/api/v1/workbooks/:workbookId', c => {
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
  return c.json(WorkbookSnapshotResponseSchema.parse({ data: workbooks.getSnapshot(workbookId.data) }));
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
  return c.json(
    WorkbookResponseSchema.parse({
      data: workbooks.connectTrueForgeSession(workbookId.data, sessionId),
    }),
  );
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

  const workbook = workbooks.getWorkbook(workbookId.data);
  if (!workbook.trueforge_session_id) {
    throw new DomainError('Workbook is not connected to TrueForge', 'workbook_not_connected', 409);
  }

  let current = workbooks.getCurrentTrueForgeTurn(workbook.id);
  if (current?.status === 'running') {
    try {
      current = workbooks.saveTrueForgeTurn(
        workbook.id,
        await trueForge.getTurn(workbook.trueforge_session_id, current.id),
      );
    } catch (error) {
      throw trueForgeUnavailable(error);
    }
    if (current.status === 'running') {
      throw new DomainError('A TrueForge turn is already running', 'turn_already_running', 409, true);
    }
  }

  try {
    const turn = await trueForge.createTurn(workbook.trueforge_session_id, input.data.input);
    return c.json(
      TrueForgeTurnResponseSchema.parse({
        data: workbooks.saveTrueForgeTurn(workbook.id, turn),
      }),
    );
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw trueForgeUnavailable(error);
  }
});

serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.serverPort,
  },
  info => console.log(`Kalki API listening on http://${info.address}:${info.port}`),
);
