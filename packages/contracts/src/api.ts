import { z } from 'zod';
import {
  BoundedSamplesSchema,
  GateKindSchema,
  IdSchema,
  JsonObjectSchema,
  MAX_TABLES_PER_TASK,
  PortableErrorSchema,
  QuestionDecisionSchema,
  RecordEnvelopeSchema,
  Sha256Schema,
  SlugSchema,
  WorkspaceRelativePathSchema,
} from './domain.js';
import { RunModeSchema } from './states.js';

const TaskMarkdownSchema = z
  .string()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 65_536,
    'task markdown exceeds 64 KiB',
  );

const TableCountsSchema = z.record(SlugSchema, z.number().int().nonnegative());

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
      value.related_run_id === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'production review answers require related_run_id',
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
    schema: JsonObjectSchema,
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
