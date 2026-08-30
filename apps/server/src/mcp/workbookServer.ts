import { serve } from '@hono/node-server';
import {
  GetWorkbookContextInputSchema,
  READ_ONLY_TOOL_ANNOTATIONS,
  RegisterTaskInputSchema,
  WorkbookToolResultSchema,
} from '@kalki/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { config } from '../config.js';
import { DomainError } from '../domain/errors.js';
import type { WorkbookService } from '../domain/workbookService.js';

function response(result: unknown) {
  const parsed = WorkbookToolResultSchema.parse(result);
  return {
    structuredContent: parsed,
    content: [{ type: 'text' as const, text: JSON.stringify(parsed) }],
  };
}

function execute(action: () => Record<string, unknown>) {
  try {
    return response({ ok: true, data: action() });
  } catch (error) {
    if (error instanceof DomainError) {
      return response({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          path: [],
          details: {},
          retryable: error.retryable,
        },
      });
    }
    console.error(error);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Workbook tool failed' }],
    };
  }
}

function createServer(workbooks: WorkbookService) {
  const server = new McpServer({ name: 'kalki-workbook', version: '0.1.0' });

  server.registerTool(
    'get_workbook_context',
    {
      description: 'Read compact workbook state without returning formal table rows.',
      inputSchema: GetWorkbookContextInputSchema.shape,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (input) => execute(() => workbooks.getWorkbookContext(GetWorkbookContextInputSchema.parse(input))),
  );

  server.registerTool(
    'register_task',
    {
      description: 'Register the current task contract for explicit review.',
      inputSchema: RegisterTaskInputSchema.shape,
    },
    (input) => execute(() => workbooks.registerTask(RegisterTaskInputSchema.parse(input))),
  );

  return server;
}

export function startWorkbookMcp(workbooks: WorkbookService) {
  if (!config.mcpToken) throw new Error('KALKI_MCP_TOKEN must be set');

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.use('/mcp', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${config.mcpToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
  );
  app.all('/mcp', async (c) => {
    const server = createServer(workbooks);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: config.mcpPort,
    },
    (info) => console.log(`Kalki workbook MCP listening on http://${info.address}:${info.port}/mcp`),
  );
}
