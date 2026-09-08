import { serve } from '@hono/node-server';
import {
  BrowserFetchPagesInputSchema,
  BrowserResearchClickInputSchema,
  BrowserResearchEvaluateInputSchema,
  BrowserResearchNavigateInputSchema,
  BrowserResearchNetworkInputSchema,
  BrowserResearchSnapshotInputSchema,
  CompleteRunInputSchema,
  GetWorkbookContextInputSchema,
  ProductionAuthorizationInputSchema,
  PublishBatchInputSchema,
  READ_ONLY_TOOL_ANNOTATIONS,
  RecordArtifactInputSchema,
  RegisterSchemaInputSchema,
  RegisterTaskInputSchema,
  StartRunInputSchema,
  WorkbookToolResultSchema,
} from '@kalki/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { config } from '../config.js';
import type { PlaywrightBrowser } from '../browser/playwrightClient.js';
import { DomainError } from '../domain/errors.js';
import type { WorkbookService } from '../domain/workbookService.js';

function response(result: unknown) {
  const parsed = WorkbookToolResultSchema.parse(result);
  return {
    structuredContent: parsed,
    content: [{ type: 'text' as const, text: JSON.stringify(parsed) }],
  };
}

async function execute(action: () => unknown | Promise<unknown>) {
  try {
    return response({ ok: true, data: await action() });
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
      content: [
        {
          type: 'text' as const,
          text: (error instanceof Error ? error.message : 'Workbook tool failed').slice(0, 1000),
        },
      ],
    };
  }
}

function createServer(workbooks: WorkbookService, browser: PlaywrightBrowser) {
  const server = new McpServer({ name: 'kalki-workbook', version: '0.1.0' });

  server.registerTool(
    'get_workbook_context',
    {
      description: 'Read compact workbook state without returning formal table rows.',
      inputSchema: GetWorkbookContextInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (input) => execute(() => workbooks.getWorkbookContext(GetWorkbookContextInputSchema.parse(input))),
  );

  server.registerTool(
    'browser_fetch_pages',
    {
      description:
        'Fetch up to five HTTP pages through the current shared browser tab and return bounded bodies for a generated operator.',
      inputSchema: BrowserFetchPagesInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (input) => execute(() => browser.fetchPages(BrowserFetchPagesInputSchema.parse(input))),
  );

  server.registerTool(
    'browser_research_navigate',
    {
      description:
        'Navigate the shared headed browser and return a compact page observation; full browser output is kept out of the model context.',
      inputSchema: BrowserResearchNavigateInputSchema,
    },
    (input) =>
      execute(() =>
        browser.researchNavigate(BrowserResearchNavigateInputSchema.parse(input)),
      ),
  );

  server.registerTool(
    'browser_research_snapshot',
    {
      description:
        'Return a bounded accessibility observation of the current shared browser page with useful structure, links, and controls.',
      inputSchema: BrowserResearchSnapshotInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (input) =>
      execute(() =>
        browser.researchSnapshot(BrowserResearchSnapshotInputSchema.parse(input)),
      ),
  );

  server.registerTool(
    'browser_research_click',
    {
      description:
        'Click one reference from the latest browser observation and return a fresh compact observation.',
      inputSchema: BrowserResearchClickInputSchema,
    },
    (input) =>
      execute(() =>
        browser.researchClick(BrowserResearchClickInputSchema.parse(input)),
      ),
  );

  server.registerTool(
    'browser_research_network',
    {
      description:
        'List compact non-static page requests, or inspect one promising request part without returning unbounded headers or bodies.',
      inputSchema: BrowserResearchNetworkInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (input) =>
      execute(() =>
        browser.researchNetwork(BrowserResearchNetworkInputSchema.parse(input)),
      ),
  );

  server.registerTool(
    'browser_research_evaluate',
    {
      description:
        'Run a bounded page extraction function and return a clipped result. Extract only fields needed to understand the source; never return full HTML.',
      inputSchema: BrowserResearchEvaluateInputSchema,
    },
    (input) =>
      execute(() =>
        browser.researchEvaluate(BrowserResearchEvaluateInputSchema.parse(input)),
      ),
  );

  server.registerTool(
    'register_task',
    {
      description: 'Register the current task contract for explicit review.',
      inputSchema: RegisterTaskInputSchema,
    },
    (input) => execute(() => workbooks.registerTask(RegisterTaskInputSchema.parse(input))),
  );

  server.registerTool(
    'register_schema',
    {
      description: 'Register the complete schema set atomically for explicit review.',
      inputSchema: RegisterSchemaInputSchema,
    },
    (input) => execute(() => workbooks.registerSchema(RegisterSchemaInputSchema.parse(input))),
  );

  server.registerTool(
    'start_run',
    {
      description: 'Create an identified test run or production run awaiting consent.',
      inputSchema: StartRunInputSchema,
    },
    (input) => execute(() => workbooks.startRun(StartRunInputSchema.parse(input))),
  );

  server.registerTool(
    'get_production_authorization',
    {
      description: 'Verify explicit production consent against current file hashes.',
      inputSchema: ProductionAuthorizationInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    (input) =>
      execute(() => workbooks.getProductionAuthorization(ProductionAuthorizationInputSchema.parse(input))),
  );

  server.registerTool(
    'publish_batch',
    {
      description: 'Publish one validated and idempotent production batch.',
      inputSchema: PublishBatchInputSchema,
    },
    (input) => execute(() => workbooks.publishBatch(PublishBatchInputSchema.parse(input))),
  );

  server.registerTool(
    'record_artifact',
    {
      description: 'Index artifact metadata without returning artifact bytes.',
      inputSchema: RecordArtifactInputSchema,
    },
    (input) => execute(() => workbooks.recordArtifact(RecordArtifactInputSchema.parse(input))),
  );

  server.registerTool(
    'complete_run',
    {
      description: 'Record a terminal test result and advance its task.',
      inputSchema: CompleteRunInputSchema,
    },
    (input) => execute(() => workbooks.completeRun(CompleteRunInputSchema.parse(input))),
  );

  return server;
}

export function startWorkbookMcp(workbooks: WorkbookService, browser: PlaywrightBrowser) {
  if (!config.mcpToken) {
    console.warn('KALKI_MCP_TOKEN is unset; workbook MCP is disabled');
    return;
  }

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
    const server = createServer(workbooks, browser);
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
