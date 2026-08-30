import { serve } from '@hono/node-server';
import {
  ApiErrorResponseSchema,
  CreateTaskInputSchema,
  CreateWorkbookInputSchema,
  HealthResponseSchema,
  IdSchema,
  TaskResponseSchema,
  WorkbookResponseSchema,
  WorkbookSnapshotResponseSchema,
} from '@kalki/contracts';
import { Hono } from 'hono';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { DomainError } from './domain/errors.js';
import { WorkbookService } from './domain/workbookService.js';

const database = openDatabase(config.databasePath);
const workbooks = new WorkbookService(database);
const app = new Hono();

app.onError((error, c) => {
  if (error instanceof DomainError) {
    return c.json(
      ApiErrorResponseSchema.parse({
        error: { code: error.code, message: error.message, path: [], details: {}, retryable: false },
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

app.get('/healthz', c => {
  database.prepare('SELECT 1').get();
  return c.json(HealthResponseSchema.parse({ ok: true }));
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

serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.serverPort,
  },
  info => console.log(`Kalki API listening on http://${info.address}:${info.port}`),
);
