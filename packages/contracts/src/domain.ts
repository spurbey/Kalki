import { z } from 'zod';
import { RunModeSchema, RunStatusSchema, TableKindSchema, TaskStateSchema } from './states.js';

export const IdSchema = z.string().trim().min(1).max(128);
export const SlugSchema = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const MAX_TABLES_PER_TASK = 10;
export const MAX_TEST_SAMPLE_RECORDS_PER_TABLE = 5;

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type TrueForgeStreamEvent = JsonObject & { type: string };

const TrueForgeStreamEventTypeSchema = z
  .string()
  .min(1)
  .max(94)
  .regex(/^[^\u0000-\u001F\u007F]*$/, 'event type cannot contain control characters');

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z
      .number()
      .finite()
      .refine(value => Math.abs(value) <= Number.MAX_SAFE_INTEGER, 'number exceeds JavaScript safe range'),
    z.string(),
    z.array(JsonValueSchema),
    JsonObjectSchema,
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.record(z.string(), JsonValueSchema).refine(value => {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }, 'value must be a plain JSON object'),
);

export const TrueForgeStreamEventSchema: z.ZodType<TrueForgeStreamEvent> = JsonObjectSchema.refine(
  (event): event is TrueForgeStreamEvent =>
    typeof event.type === 'string' && TrueForgeStreamEventTypeSchema.safeParse(event.type).success,
  'TrueForge stream event requires a type',
);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return serialized;
}

function utf16Hex(value: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return encoded;
}

function hashTree(value: unknown): unknown {
  if (value === null) return { t: 'null' };
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Value is outside the shared JSON number range');
    }
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, Object.is(value, -0) ? 0 : value, false);
    const bytes = Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
    return { t: 'number', v: bytes };
  }
  if (typeof value === 'string') return { t: 'string', v: utf16Hex(value) };
  if (Array.isArray(value)) return { t: 'array', v: value.map(hashTree) };
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Value is not JSON serializable');
    }
    const object = value as Record<string, unknown>;
    return {
      t: 'object',
      v: Object.keys(object)
        .sort()
        .map(key => [utf16Hex(key), hashTree(object[key])]),
    };
  }
  throw new TypeError('Value is not JSON serializable');
}

export function canonicalHashJson(value: unknown): string {
  return canonicalJson(hashTree(value));
}

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

export const DedupeKeySchema = z
  .string()
  .min(1)
  .refine(value => new TextEncoder().encode(value).byteLength <= 512, 'dedupe key exceeds 512 UTF-8 bytes');

export const ProvenanceParentSchema = z
  .object({
    table_slug: SlugSchema,
    dedupe_key: DedupeKeySchema,
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

export const TrueForgeTurnStatusSchema = z.enum(['running', 'done', 'cancelled', 'error']);
export type TrueForgeTurnStatus = z.infer<typeof TrueForgeTurnStatusSchema>;

export const TrueForgeTurnInputSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    previousTurnId: IdSchema.nullable(),
    status: TrueForgeTurnStatusSchema,
    requiredActions: z.array(JsonValueSchema),
    createdAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
  })
  .strict();
export type TrueForgeTurnInput = z.infer<typeof TrueForgeTurnInputSchema>;

export const TrueForgeTurnSchema = z
  .object({
    id: IdSchema,
    workbook_id: IdSchema,
    previous_turn_id: IdSchema.nullable(),
    status: TrueForgeTurnStatusSchema,
    last_sequence_number: z.number().int().nonnegative(),
    required_actions: z.array(JsonValueSchema),
    started_at: TimestampSchema,
    finished_at: TimestampSchema.nullable(),
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

export const BoundedSamplesSchema = z
  .record(SlugSchema, z.array(RecordEnvelopeSchema).max(MAX_TEST_SAMPLE_RECORDS_PER_TABLE))
  .refine(value => Object.keys(value).length <= MAX_TABLES_PER_TASK, {
    message: `test samples cannot contain more than ${MAX_TABLES_PER_TASK} tables`,
  });

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
  .strict()
  .superRefine((value, context) => {
    const approvalValues = [
      value.approved_at,
      value.approval_event_id,
      value.approved_task_hash,
      value.approved_schema_hash,
      value.approved_pipeline_hash,
    ];
    const hasAnyApproval = approvalValues.some(item => item !== null);
    const hasCompleteApproval = approvalValues.every(item => item !== null);

    if (hasAnyApproval && !hasCompleteApproval) {
      context.addIssue({
        code: 'custom',
        message: 'approval evidence must be entirely present or entirely absent',
        path: ['approved_at'],
      });
    }

    if (value.mode === 'test') {
      if (value.status === 'awaiting_confirmation' || value.status === 'authorized' || value.status === 'finalizing') {
        context.addIssue({
          code: 'custom',
          message: 'test runs cannot use production-only statuses',
          path: ['status'],
        });
      }
      if (hasAnyApproval) {
        context.addIssue({
          code: 'custom',
          message: 'test runs cannot contain production approval evidence',
          path: ['approved_at'],
        });
      }
    }

    const requiresApproval =
      value.mode === 'production' &&
      (value.status === 'authorized' ||
        value.status === 'running' ||
        value.status === 'finalizing' ||
        value.status === 'completed');

    if (requiresApproval && !hasCompleteApproval) {
      context.addIssue({
        code: 'custom',
        message: 'this production status requires complete approval evidence',
        path: ['approved_at'],
      });
    }

    if (value.mode === 'production' && value.status === 'awaiting_confirmation' && hasAnyApproval) {
      context.addIssue({
        code: 'custom',
        message: 'awaiting-confirmation runs cannot already contain approval evidence',
        path: ['approved_at'],
      });
    }

    if (hasCompleteApproval) {
      const hashPairs = [
        ['approved_task_hash', value.approved_task_hash, value.task_hash],
        ['approved_schema_hash', value.approved_schema_hash, value.schema_hash],
        ['approved_pipeline_hash', value.approved_pipeline_hash, value.pipeline_hash],
      ] as const;

      for (const [field, approvedHash, currentHash] of hashPairs) {
        if (approvedHash !== currentHash) {
          context.addIssue({
            code: 'custom',
            message: 'approved hash must match the current run hash',
            path: [field],
          });
        }
      }
    }
  });

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
export type TrueForgeTurn = z.infer<typeof TrueForgeTurnSchema>;
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
