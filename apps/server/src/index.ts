import { serve } from '@hono/node-server';
import { CreateTaskInputSchema, CreateWorkbookInputSchema } from '@kalki/contracts';
import { Hono } from 'hono';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { NotFoundError } from './domain/errors.js';
import { WorkbookService } from './domain/workbookService.js';

const database = openDatabase(config.databasePath);
const workbooks = new WorkbookService(database);
const app = new Hono();

app.onError((error, c) => {
  if (error instanceof NotFoundError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof SyntaxError) {
    return c.json({ error: { code: 'invalid_request', message: 'Request body must be valid JSON' } }, 400);
  }
  console.error(error);
  return c.json({ error: { code: 'internal_error', message: 'Unexpected server error' } }, 500);
});

app.get('/healthz', c => {
  database.prepare('SELECT 1').get();
  return c.json({ ok: true });
});

app.post('/api/v1/workbooks', async c => {
  const input = CreateWorkbookInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json({ error: { code: 'invalid_request', message: 'Invalid workbook input' } }, 400);
  }
  return c.json({ data: workbooks.createWorkbook(input.data) }, 201);
});

app.get('/api/v1/workbooks/:workbookId', c =>
  c.json({ data: workbooks.getSnapshot(c.req.param('workbookId')) }),
);

app.post('/api/v1/workbooks/:workbookId/tasks', async c => {
  const input = CreateTaskInputSchema.safeParse(await c.req.json());
  if (!input.success) {
    return c.json({ error: { code: 'invalid_request', message: 'Invalid task input' } }, 400);
  }
  return c.json({ data: workbooks.createTask(c.req.param('workbookId'), input.data) }, 201);
});

serve(
  {
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: config.serverPort,
  },
  info => console.log(`Kalki API listening on http://${info.address}:${info.port}`),
);
