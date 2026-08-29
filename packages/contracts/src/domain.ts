import { z } from 'zod';
import { RunModeSchema, RunStatusSchema, TableKindSchema, TaskStateSchema } from './states.js';

export const IdSchema = z.string().trim().min(1).max(128);
export const SlugSchema = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(value => !value.includes('\\') && !value.includes('\0'), 'path must use POSIX separators')
  .refine(value => !value.startsWith('/') && !/^[A-Za-z]:/.test(value), 'path must be relative')
  .refine(
    value => value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    'path must be normalized and stay inside the workspace',
  );

export const HttpsUrlSchema = z.url().refine(value => new URL(value).protocol === 'https:', {
  message: 'URL must use HTTPS',
});

export const PortableErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).default([]),
    details: JsonObjectSchema.default({}),
    retryable: z.boolean(),
  })
  .strict();

export const ProvenanceParentSchema = z
  .object({
    table_slug: SlugSchema,
    dedupe_key: z.string().min(1).max(512),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    kind: z.enum(['direct', 'derived']),
    source_url: HttpsUrlSchema,
    retrieved_at: TimestampSchema,
    source_record_id: z.string().min(1).max(512).optional(),
    evidence_path: WorkspaceRelativePathSchema.optional(),
    source_hash: Sha256Schema.optional(),
    parents: z.array(ProvenanceParentSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'direct' && value.parents.length !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'direct provenance cannot have parents',
        path: ['parents'],
      });
    }
    if (value.kind === 'derived' && value.parents.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'derived provenance requires at least one parent',
        path: ['parents'],
      });
    }
  });

export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DedupeKeySchema = z
  .string()
  .min(1)
  .refine(value => new TextEncoder().encode(value).byteLength <= 512, 'dedupe key exceeds 512 UTF-8 bytes');

export const RecordEnvelopeSchema = z
  .object({
    data: JsonObjectSchema,
    dedupe_key: DedupeKeySchema,
    provenance: ProvenanceSchema,
  })
  .strict();

export type RecordEnvelope = z.infer<typeof RecordEnvelopeSchema>;

export const WorkbookSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(200),
    trueforge_session_id: IdSchema.nullable(),
    current_trueforge_turn_id: IdSchema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const TaskSchema = z
  .object({
    id: IdSchema,
    workbook_id: IdSchema,
    slug: SlugSchema,
    title: z.string().min(1).max(200),
    objective: z.string().min(1),
    state: TaskStateSchema,
    task_path: WorkspaceRelativePathSchema.nullable(),
    task_markdown: z.string().max(65_536).nullable(),
    task_hash: Sha256Schema.nullable(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const TableSchema = z
  .object({
    id: IdSchema,
    task_id: IdSchema,
    slug: SlugSchema,
    name: z.string().min(1).max(200),
    kind: TableKindSchema,
    ordinal: z.number().int().nonnegative(),
    schema_path: WorkspaceRelativePathSchema,
    schema: JsonObjectSchema,
    schema_hash: Sha256Schema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const BoundedSamplesSchema = z.record(
  SlugSchema,
  z.array(RecordEnvelopeSchema).max(5),
);

export const RunSchema = z
  .object({
    id: IdSchema,
    task_id: IdSchema,
    mode: RunModeSchema,
    status: RunStatusSchema,
    task_hash: Sha256Schema,
    schema_hash: Sha256Schema,
    pipeline_hash: Sha256Schema,
    approved_at: TimestampSchema.nullable(),
    approval_event_id: IdSchema.nullable(),
    approved_task_hash: Sha256Schema.nullable(),
    approved_schema_hash: Sha256Schema.nullable(),
    approved_pipeline_hash: Sha256Schema.nullable(),
    test_manifest: JsonObjectSchema.nullable(),
    test_samples: BoundedSamplesSchema.nullable(),
    published_row_count: z.number().int().nonnegative(),
    total_record_count: z.number().int().nonnegative().nullable(),
    error: PortableErrorSchema.nullable(),
    created_at: TimestampSchema,
    started_at: TimestampSchema.nullable(),
    finished_at: TimestampSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .strict();

export const GateKindSchema = z.enum([
  'clarification',
  'task_review',
  'schema_review',
  'production_review',
  'skill_promotion_review',
]);

export const QuestionDecisionSchema = z.enum(['approve', 'revise', 'skip', 'cancel', 'free_text']);

export const AgentQuestionSchema = z
  .object({
    id: IdSchema,
    workbook_id: IdSchema,
    task_id: IdSchema.nullable(),
    run_id: IdSchema.nullable(),
    gate_kind: GateKindSchema,
    question_turn_id: IdSchema,
    question_event_id: IdSchema,
    tool_call_id: IdSchema,
    thread_id: IdSchema,
    question_text: z.string().min(1).max(2000),
    options: z.array(z.string().min(1).max(200)).max(5),
    status: z.enum(['pending', 'submitting', 'answered', 'submission_unknown', 'invalidated']),
    answer_text: z.string().max(4000).nullable(),
    decision: QuestionDecisionSchema.nullable(),
    answer_turn_id: IdSchema.nullable(),
    created_at: TimestampSchema,
    answered_at: TimestampSchema.nullable(),
  })
  .strict();

export const ApprovalEventSchema = z
  .object({
    id: IdSchema,
    workbook_id: IdSchema,
    task_id: IdSchema,
    run_id: IdSchema,
    agent_question_id: IdSchema,
    question_event_id: IdSchema,
    tool_call_id: IdSchema,
    question_turn_id: IdSchema,
    answer_turn_id: IdSchema,
    answer_text: z.string().min(1).max(4000),
    approved_task_hash: Sha256Schema,
    approved_schema_hash: Sha256Schema,
    approved_pipeline_hash: Sha256Schema,
    created_at: TimestampSchema,
  })
  .strict();

export const RunBatchSchema = z
  .object({
    id: IdSchema,
    run_id: IdSchema,
    table_id: IdSchema,
    batch_key: z.string().min(1).max(200),
    payload_hash: Sha256Schema,
    row_count: z.number().int().min(1).max(50),
    inserted_count: z.number().int().nonnegative(),
    duplicate_count: z.number().int().nonnegative(),
    published_row_count_after: z.number().int().nonnegative(),
    created_at: TimestampSchema,
  })
  .strict();

export const TableRowSchema = z
  .object({
    id: IdSchema,
    table_id: IdSchema,
    run_id: IdSchema,
    batch_id: IdSchema,
    dedupe_key: DedupeKeySchema,
    data: JsonObjectSchema,
    provenance: ProvenanceSchema,
    envelope_hash: Sha256Schema,
    created_at: TimestampSchema,
  })
  .strict();

export const ArtifactSchema = z
  .object({
    id: IdSchema,
    run_id: IdSchema,
    trueforge_turn_id: IdSchema,
    kind: z.string().min(1).max(100),
    path: WorkspaceRelativePathSchema,
    sha256: Sha256Schema,
    size_bytes: z.number().int().nonnegative(),
    mime_type: z.string().min(1).max(200),
    metadata: JsonObjectSchema,
    created_at: TimestampSchema,
  })
  .strict();

export const GeneratedSkillSchema = z
  .object({
    id: IdSchema,
    workbook_id: IdSchema,
    run_id: IdSchema,
    name: SlugSchema,
    repo_url: HttpsUrlSchema,
    repo_path: WorkspaceRelativePathSchema,
    commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
    trueforge_skill_name: SlugSchema,
    registration_status: z.string().min(1).max(100),
    mount_smoke_status: z.string().min(1).max(100),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const WorkbookEventSchema = z
  .object({
    seq: z.number().int().positive(),
    workbook_id: IdSchema,
    type: z.string().min(1).max(100),
    payload: JsonObjectSchema,
    created_at: TimestampSchema,
  })
  .strict();

export const WorkbookSnapshotSchema = z
  .object({
    workbook: WorkbookSchema,
    tasks: z.array(TaskSchema),
    tables: z.array(TableSchema),
    runs: z.array(RunSchema),
    pending_question: AgentQuestionSchema.nullable(),
    artifacts: z.array(ArtifactSchema),
    generated_skills: z.array(GeneratedSkillSchema),
    table_counts: z.record(IdSchema, z.number().int().nonnegative()),
  })
  .strict();

export type PortableError = z.infer<typeof PortableErrorSchema>;
export type Workbook = z.infer<typeof WorkbookSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type KalkiTable = z.infer<typeof TableSchema>;
export type Run = z.infer<typeof RunSchema>;
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;
export type RunBatch = z.infer<typeof RunBatchSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type GeneratedSkill = z.infer<typeof GeneratedSkillSchema>;
export type WorkbookEvent = z.infer<typeof WorkbookEventSchema>;
export type WorkbookSnapshot = z.infer<typeof WorkbookSnapshotSchema>;
