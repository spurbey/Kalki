import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AgentQuestionSchema,
  ArtifactSchema,
  BoundedSamplesSchema,
  GateKindSchema,
  GeneratedSkillSchema,
  IdSchema,
  JsonObjectSchema,
  MAX_SAFE_JSON_NUMBER,
  MAX_TABLES_PER_TASK,
  PortableErrorSchema,
  QuestionDecisionSchema,
  RecordEnvelopeSchema,
  Sha256Schema,
  SlugSchema,
  TaskSchema,
  TableRowSchema,
  TimestampSchema,
  TrueForgeTurnSchema,
  WorkbookSchema,
  WorkbookSnapshotSchema,
  WorkspaceRelativePathSchema,
} from './domain.js';
import { RunModeSchema, RunStatusSchema, TableKindSchema } from './states.js';

const TaskMarkdownSchema = z
  .string()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 65_536,
    'task markdown exceeds 64 KiB',
  );

const TableCountsSchema = z.record(SlugSchema, z.number().int().nonnegative());

const SchemaColumnNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const SchemaColumnSchema = z
  .object({
    name: SchemaColumnNameSchema,
    type: z.enum(['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'url', 'enum']),
    nullable: z.boolean(),
    description: z.string().trim().min(1).max(2000),
    minimum: z.number().finite().refine(value => Math.abs(value) <= MAX_SAFE_JSON_NUMBER).optional(),
    maximum: z.number().finite().refine(value => Math.abs(value) <= MAX_SAFE_JSON_NUMBER).optional(),
    pattern: z.string().min(1).max(1000).optional(),
    values: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((column, context) => {
    const numeric = column.type === 'integer' || column.type === 'number';
    if (column.minimum !== undefined && column.maximum !== undefined && column.minimum > column.maximum) {
      context.addIssue({ code: 'custom', message: 'minimum cannot exceed maximum', path: ['minimum'] });
    }
    if (!numeric && (column.minimum !== undefined || column.maximum !== undefined)) {
      context.addIssue({ code: 'custom', message: 'numeric bounds require a numeric column', path: ['minimum'] });
    }
    if (column.pattern !== undefined && column.type !== 'string') {
      context.addIssue({ code: 'custom', message: 'pattern is only valid for string columns', path: ['pattern'] });
    }
    if (column.type === 'enum' && column.values === undefined) {
      context.addIssue({ code: 'custom', message: 'enum columns require values', path: ['values'] });
    }
    if (column.type !== 'enum' && column.values !== undefined) {
      context.addIssue({ code: 'custom', message: 'values are only valid for enum columns', path: ['values'] });
    }
  });

export const TableSchemaDocumentSchema = z
  .object({
    version: z.literal(1),
    table: z
      .object({
        slug: SlugSchema,
        name: z.string().trim().min(1).max(200),
        kind: TableKindSchema,
        description: z.string().trim().min(1).max(2000),
        primary_key: z.array(SchemaColumnNameSchema).min(1),
      })
      .strict(),
    columns: z.array(SchemaColumnSchema).min(1),
  })
  .strict()
  .superRefine((schema, context) => {
    const columns = new Map(schema.columns.map(column => [column.name, column]));
    if (columns.size !== schema.columns.length) {
      context.addIssue({ code: 'custom', message: 'column names must be unique', path: ['columns'] });
    }
    if (new Set(schema.table.primary_key).size !== schema.table.primary_key.length) {
      context.addIssue({ code: 'custom', message: 'primary key columns must be unique', path: ['table', 'primary_key'] });
    }
    schema.table.primary_key.forEach((name, index) => {
      const column = columns.get(name);
      if (!column) {
        context.addIssue({ code: 'custom', message: 'primary key column is not declared', path: ['table', 'primary_key', index] });
      } else if (column.nullable) {
        context.addIssue({ code: 'custom', message: 'primary key columns cannot be nullable', path: ['columns'] });
      }
    });
  });

export const CreateWorkbookInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const CreateTaskInputSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().trim().min(1).max(200),
    objective: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const CreateTurnInputSchema = z
  .object({
    input: z.string().trim().min(1).max(32_768),
  })
  .strict();

export const GetWorkbookContextDataSchema = z
  .object({
    workbook: WorkbookSchema.pick({
      id: true,
      title: true,
      trueforge_session_id: true,
      current_trueforge_turn_id: true,
    }),
    task: TaskSchema.pick({
      id: true,
      state: true,
      task_path: true,
      task_hash: true,
    }).nullable(),
    tables: z.array(
      z
        .object({
          id: IdSchema,
          slug: SlugSchema,
          kind: TableKindSchema,
          schema_hash: Sha256Schema,
        })
        .strict(),
    ),
    aggregate_schema_hash: Sha256Schema.nullable(),
    runs: z.array(
      z
        .object({
          id: IdSchema,
          mode: RunModeSchema,
          status: RunStatusSchema,
          hashes: z
            .object({
              task: Sha256Schema,
              schema: Sha256Schema,
              pipeline: Sha256Schema,
            })
            .strict(),
          counts: z.object({ formal_rows: z.number().int().nonnegative() }).strict(),
        })
        .strict(),
    ),
    pending_question: AgentQuestionSchema.nullable(),
    artifacts: z.array(ArtifactSchema),
    generated_skills: z.array(GeneratedSkillSchema),
    next_expected_action: z.string().min(1).max(100),
  })
  .strict();

export const RegisterTaskDataSchema = z
  .object({
    task_id: IdSchema,
    state: z.literal('awaiting_task_confirmation'),
    task_path: WorkspaceRelativePathSchema,
    task_hash: Sha256Schema,
    next_action: z.literal('ask_task_review'),
  })
  .strict();

export const RegisterSchemaDataSchema = z
  .object({
    task_id: IdSchema,
    state: z.literal('awaiting_schema_review'),
    tables: z.array(
      z
        .object({
          id: IdSchema,
          slug: SlugSchema,
          kind: TableKindSchema,
          schema_hash: Sha256Schema,
        })
        .strict(),
    ),
    aggregate_schema_hash: Sha256Schema,
    next_action: z.literal('ask_schema_review'),
  })
  .strict();

export const StartRunDataSchema = z
  .object({
    run_id: IdSchema,
    mode: RunModeSchema,
    status: RunStatusSchema,
    hashes: z
      .object({
        task: Sha256Schema,
        schema: Sha256Schema,
        pipeline: Sha256Schema,
      })
      .strict(),
    next_action: z.enum(['execute_test', 'ask_production_review']),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    trueforge: z.boolean(),
  })
  .strict();

const BrowserUrlSchema = z
  .string()
  .trim()
  .max(4000)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'Browser URL must use HTTP or HTTPS');

export const BrowserStatusSchema = z
  .object({
    available: z.boolean(),
    url: z.string().max(4000).nullable(),
    title: z.string().max(1000).nullable(),
    tab_count: z.number().int().nonnegative(),
    screenshot_at: TimestampSchema.nullable(),
    error: z.string().max(1000).nullable(),
  })
  .strict();

export const BrowserStatusResponseSchema = z.object({ data: BrowserStatusSchema }).strict();

export const BrowserNavigateInputSchema = z.object({ url: BrowserUrlSchema }).strict();

const BrowserCoordinateSchema = z.number().int().min(0).max(10_000);

export const BrowserInteractionInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('click'),
      x: BrowserCoordinateSchema,
      y: BrowserCoordinateSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      x: BrowserCoordinateSchema,
      y: BrowserCoordinateSchema,
      delta_x: z.number().int().min(-10_000).max(10_000),
      delta_y: z.number().int().min(-10_000).max(10_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('type'),
      text: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal('key'),
      key: z.string().min(1).max(50).regex(/^[A-Za-z0-9+]+$/),
    })
    .strict(),
]);

export const PlaywrightToolResultSchema = CallToolResultSchema;

export type PlaywrightToolResult = z.infer<typeof PlaywrightToolResultSchema>;

export const WorkbookResponseSchema = z.object({ data: WorkbookSchema }).strict();
export const TaskResponseSchema = z.object({ data: TaskSchema }).strict();
export const TrueForgeTurnResponseSchema = z.object({ data: TrueForgeTurnSchema }).strict();
export const WorkbookSnapshotResponseSchema = z.object({ data: WorkbookSnapshotSchema }).strict();
export const TableRowsQuerySchema = z
  .object({
    run_id: IdSchema,
    after: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const TableRowsResponseSchema = z
  .object({
    data: z
      .object({
        table_id: IdSchema,
        run_id: IdSchema,
        rows: z.array(TableRowSchema),
        next_cursor: z.string().min(1).max(512).nullable(),
      })
      .strict(),
  })
  .strict();
export const ApiErrorResponseSchema = z.object({ error: PortableErrorSchema }).strict();

export const AnswerQuestionInputSchema = z
  .object({
    question_event_id: IdSchema,
    question_turn_id: IdSchema,
    thread_id: IdSchema,
    answer: z.string().min(1).max(4000),
    decision: QuestionDecisionSchema,
    gate_kind: GateKindSchema,
    related_run_id: IdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.gate_kind === 'production_review' &&
      value.decision === 'approve' &&
      value.related_run_id === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'production approval requires related_run_id',
        path: ['related_run_id'],
      });
    }
  });

export const GetWorkbookContextInputSchema = z
  .object({
    workbook_id: IdSchema,
    task_id: IdSchema.optional(),
  })
  .strict();

export const RegisterTaskInputSchema = z
  .object({
    task_id: IdSchema,
    task_path: WorkspaceRelativePathSchema,
    task_markdown: TaskMarkdownSchema,
    task_hash: Sha256Schema,
  })
  .strict();

export const SchemaRegistrationSchema = z
  .object({
    path: WorkspaceRelativePathSchema,
    schema: TableSchemaDocumentSchema,
    schema_hash: Sha256Schema,
  })
  .strict();

export const RegisterSchemaInputSchema = z
  .object({
    task_id: IdSchema,
    schemas: z.array(SchemaRegistrationSchema).min(1).max(MAX_TABLES_PER_TASK),
    aggregate_schema_hash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const seenPaths = new Set<string>();

    value.schemas.forEach((schema, index) => {
      if (seenPaths.has(schema.path)) {
        context.addIssue({
          code: 'custom',
          message: 'schema paths must be unique within one registration',
          path: ['schemas', index, 'path'],
        });
      }
      seenPaths.add(schema.path);
    });
  });

export const StartRunInputSchema = z
  .object({
    run_id: IdSchema,
    task_id: IdSchema,
    mode: RunModeSchema,
    task_hash: Sha256Schema,
    schema_hash: Sha256Schema,
    pipeline_hash: Sha256Schema,
  })
  .strict();

export const ProductionAuthorizationInputSchema = z
  .object({
    run_id: IdSchema,
    task_hash: Sha256Schema,
    schema_hash: Sha256Schema,
    pipeline_hash: Sha256Schema,
  })
  .strict();

export const PublishBatchInputSchema = z
  .object({
    run_id: IdSchema,
    table_slug: SlugSchema,
    batch_key: z.string().min(1).max(200),
    payload_hash: Sha256Schema,
    task_hash: Sha256Schema,
    schema_hash: Sha256Schema,
    pipeline_hash: Sha256Schema,
    records: z.array(RecordEnvelopeSchema).min(1).max(50),
  })
  .strict();

export const RecordArtifactInputSchema = z
  .object({
    run_id: IdSchema,
    trueforge_turn_id: IdSchema,
    kind: z.string().min(1).max(100),
    path: WorkspaceRelativePathSchema,
    sha256: Sha256Schema,
    size_bytes: z.number().int().nonnegative(),
    mime_type: z.string().min(1).max(200),
    metadata: JsonObjectSchema,
    task_hash: Sha256Schema,
    schema_hash: Sha256Schema,
    pipeline_hash: Sha256Schema,
  })
  .strict();

export const RunOutcomeSchema = z.enum(['completed', 'failed', 'cancelled']);

export const CompleteRunInputSchema = z
  .object({
    run_id: IdSchema,
    outcome: RunOutcomeSchema,
    task_hash: Sha256Schema,
    schema_hash: Sha256Schema,
    pipeline_hash: Sha256Schema,
    manifest: JsonObjectSchema,
    samples: BoundedSamplesSchema,
    table_counts: TableCountsSchema,
    error: PortableErrorSchema.nullable(),
  })
  .strict();

export const PromoteSkillInputSchema = z
  .object({
    workbook_id: IdSchema,
    run_id: IdSchema,
    artifact_id: IdSchema,
    agent_question_id: IdSchema,
    name: SlugSchema,
    description: z.string().trim().min(1).max(1000),
  })
  .strict();

export const WorkbookToolSuccessSchema = z
  .object({
    ok: z.literal(true),
    data: JsonObjectSchema,
  })
  .strict();

export const WorkbookToolFailureSchema = z
  .object({
    ok: z.literal(false),
    error: PortableErrorSchema,
  })
  .strict();

export const WorkbookToolResultSchema = z.discriminatedUnion('ok', [
  WorkbookToolSuccessSchema,
  WorkbookToolFailureSchema,
]);

export const WorkbookToolNameSchema = z.enum([
  'get_workbook_context',
  'register_task',
  'register_schema',
  'start_run',
  'get_production_authorization',
  'publish_batch',
  'record_artifact',
  'complete_run',
  'promote_skill',
]);

export type WorkbookToolName = z.infer<typeof WorkbookToolNameSchema>;

export const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const);

type WorkbookToolDefinition = {
  name: WorkbookToolName;
  description: string;
  inputSchema: z.ZodType;
  annotations?: typeof READ_ONLY_TOOL_ANNOTATIONS;
};

export const WORKBOOK_TOOL_DEFINITIONS = [
  {
    name: 'get_workbook_context',
    description:
      'Read compact workbook state without returning formal table rows.',
    inputSchema: GetWorkbookContextInputSchema,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: 'register_task',
    description: 'Register the current task contract for explicit review.',
    inputSchema: RegisterTaskInputSchema,
  },
  {
    name: 'register_schema',
    description:
      'Register the complete schema set atomically for explicit review.',
    inputSchema: RegisterSchemaInputSchema,
  },
  {
    name: 'start_run',
    description:
      'Create an identified test run or production run awaiting consent.',
    inputSchema: StartRunInputSchema,
  },
  {
    name: 'get_production_authorization',
    description:
      'Verify explicit production consent against current file hashes.',
    inputSchema: ProductionAuthorizationInputSchema,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: 'publish_batch',
    description: 'Publish one validated and idempotent production batch.',
    inputSchema: PublishBatchInputSchema,
  },
  {
    name: 'record_artifact',
    description: 'Index artifact metadata without returning artifact bytes.',
    inputSchema: RecordArtifactInputSchema,
  },
  {
    name: 'complete_run',
    description: 'Record a terminal test result or finalize a production run.',
    inputSchema: CompleteRunInputSchema,
  },
  {
    name: 'promote_skill',
    description: 'Promote an explicitly approved generated skill bundle.',
    inputSchema: PromoteSkillInputSchema,
  },
] as const satisfies readonly WorkbookToolDefinition[];

export type CreateWorkbookInput = z.infer<typeof CreateWorkbookInputSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export type CreateTurnInput = z.infer<typeof CreateTurnInputSchema>;
export type GetWorkbookContextData = z.infer<
  typeof GetWorkbookContextDataSchema
>;
export type RegisterTaskData = z.infer<typeof RegisterTaskDataSchema>;
export type RegisterSchemaData = z.infer<typeof RegisterSchemaDataSchema>;
export type StartRunData = z.infer<typeof StartRunDataSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;
export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInputSchema>;
export type BrowserInteractionInput = z.infer<typeof BrowserInteractionInputSchema>;
export type BrowserStatusResponse = z.infer<typeof BrowserStatusResponseSchema>;
export type WorkbookResponse = z.infer<typeof WorkbookResponseSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type TrueForgeTurnResponse = z.infer<typeof TrueForgeTurnResponseSchema>;
export type WorkbookSnapshotResponse = z.infer<typeof WorkbookSnapshotResponseSchema>;
export type TableRowsQuery = z.infer<typeof TableRowsQuerySchema>;
export type TableRowsResponse = z.infer<typeof TableRowsResponseSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInputSchema>;
export type GetWorkbookContextInput = z.infer<
  typeof GetWorkbookContextInputSchema
>;
export type RegisterTaskInput = z.infer<typeof RegisterTaskInputSchema>;
export type RegisterSchemaInput = z.infer<typeof RegisterSchemaInputSchema>;
export type StartRunInput = z.infer<typeof StartRunInputSchema>;
export type ProductionAuthorizationInput = z.infer<
  typeof ProductionAuthorizationInputSchema
>;
export type PublishBatchInput = z.infer<typeof PublishBatchInputSchema>;
export type RecordArtifactInput = z.infer<typeof RecordArtifactInputSchema>;
export type CompleteRunInput = z.infer<typeof CompleteRunInputSchema>;
export type PromoteSkillInput = z.infer<typeof PromoteSkillInputSchema>;
export type WorkbookToolResult = z.infer<typeof WorkbookToolResultSchema>;
