import { describe, expect, it } from 'vitest';
import {
  AnswerQuestionInputSchema,
  CompleteRunInputSchema,
  BrowserInteractionInputSchema,
  BrowserNavigateInputSchema,
  PlaywrightToolResultSchema,
  PublishBatchInputSchema,
  RegisterSchemaInputSchema,
  StartRunInputSchema,
  TableSchemaDocumentSchema,
  WORKBOOK_TOOL_DEFINITIONS,
} from './api.js';

const hash = 'a'.repeat(64);

const record = {
  data: { date: '2025-01-02', close: 379.28 },
  dedupe_key: '2025-01-02',
  provenance: {
    kind: 'direct',
    source_url: 'https://query1.finance.yahoo.com/v8/finance/chart/TSLA',
    retrieved_at: '2026-08-29T12:00:00Z',
    source_record_id: 'TSLA:2025-01-02',
    parents: [],
  },
} as const;

const publication = {
  run_id: 'run_1',
  table_slug: 'tesla-history',
  batch_key: 'tesla-history:00000000',
  payload_hash: hash,
  task_hash: hash,
  schema_hash: hash,
  pipeline_hash: hash,
  records: [record],
};

describe('workbook MCP surface', () => {
  it('advertises exactly the nine reviewed tools', () => {
    expect(WORKBOOK_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
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
  });

  it('does not expose direct approval or arbitrary transition tools', () => {
    const names = WORKBOOK_TOOL_DEFINITIONS.map((tool) => tool.name as string);
    expect(names).not.toContain('approve_run');
    expect(names).not.toContain('transition_task');
  });

  it('only annotates read-only tools', () => {
    const annotations = WORKBOOK_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      annotations: 'annotations' in tool ? tool.annotations : undefined,
    }));

    expect(annotations).toEqual([
      {
        name: 'get_workbook_context',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      { name: 'register_task', annotations: undefined },
      { name: 'register_schema', annotations: undefined },
      { name: 'start_run', annotations: undefined },
      {
        name: 'get_production_authorization',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      { name: 'publish_batch', annotations: undefined },
      { name: 'record_artifact', annotations: undefined },
      { name: 'complete_run', annotations: undefined },
      { name: 'promote_skill', annotations: undefined },
    ]);
  });
});

describe('browser boundary', () => {
  it('bounds navigation URLs and validates MCP tool results', () => {
    expect(
      BrowserNavigateInputSchema.safeParse({
        url: `https://example.com/${'a'.repeat(4000)}`,
      }).success,
    ).toBe(false);
    expect(
      PlaywrightToolResultSchema.safeParse({
        content: [{ type: 'text', text: 'ok' }],
      }).success,
    ).toBe(true);
    expect(
      PlaywrightToolResultSchema.safeParse({ content: [{ type: 'text' }] })
        .success,
    ).toBe(false);
    expect(
      PlaywrightToolResultSchema.safeParse({
        content: [{ type: 'image', text: 'not image data' }],
      }).success,
    ).toBe(false);
    expect(PlaywrightToolResultSchema.safeParse({ content: 'ok' }).success).toBe(false);
  });

  it('bounds browser interactions', () => {
    expect(
      BrowserInteractionInputSchema.safeParse({ action: 'click', x: 120, y: 80 })
        .success,
    ).toBe(true);
    expect(
      BrowserInteractionInputSchema.safeParse({
        action: 'type',
        text: 'a'.repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      BrowserInteractionInputSchema.safeParse({
        action: 'key',
        key: 'Enter); process.exit()',
      }).success,
    ).toBe(false);
  });
});

describe('production publication', () => {
  it('accepts 50 records and rejects 51', () => {
    expect(
      PublishBatchInputSchema.safeParse({
        ...publication,
        records: Array(50).fill(record),
      }).success,
    ).toBe(true);
    expect(
      PublishBatchInputSchema.safeParse({
        ...publication,
        records: Array(51).fill(record),
      }).success,
    ).toBe(false);
  });

  it.each([
    'payload_hash',
    'task_hash',
    'schema_hash',
    'pipeline_hash',
  ] as const)('requires %s', (field) => {
    const input: Record<string, unknown> = { ...publication };
    delete input[field];
    expect(PublishBatchInputSchema.safeParse(input).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(
      PublishBatchInputSchema.safeParse({ ...publication, force: true })
        .success,
    ).toBe(false);
  });
});

describe('run and review commands', () => {
  it('keeps schema bounds within the shared JSON number range', () => {
    const schema = {
      version: 1 as const,
      table: {
        slug: 'prices',
        name: 'Prices',
        kind: 'source' as const,
        description: 'Price history',
        primary_key: ['value'],
      },
      columns: [
        {
          name: 'value',
          type: 'number' as const,
          nullable: false,
          description: 'A price',
        },
      ],
    };

    expect(
      TableSchemaDocumentSchema.safeParse({
        ...schema,
        columns: [{ ...schema.columns[0], maximum: Number.MAX_SAFE_INTEGER + 1 }],
      }).success,
    ).toBe(false);
    expect(
      TableSchemaDocumentSchema.safeParse({
        ...schema,
        columns: [{ ...schema.columns[0], minimum: Number.MIN_SAFE_INTEGER - 1 }],
      }).success,
    ).toBe(false);
  });

  it('requires the caller to provide the run identity', () => {
    expect(
      StartRunInputSchema.safeParse({
        task_id: 'task_1',
        mode: 'test',
        task_hash: hash,
        schema_hash: hash,
        pipeline_hash: hash,
      }).success,
    ).toBe(false);
  });

  it('registers at least one schema as one atomic set', () => {
    expect(
      RegisterSchemaInputSchema.safeParse({
        task_id: 'task_1',
        schemas: [],
        aggregate_schema_hash: hash,
      }).success,
    ).toBe(false);
  });

  it('requires a related run only for production approval', () => {
    const answer = {
      question_event_id: 'event_1',
      question_turn_id: 'turn_1',
      thread_id: 'main',
      answer: 'Approve production using the reviewed workflow.',
      decision: 'approve',
      gate_kind: 'production_review',
    };

    expect(AnswerQuestionInputSchema.safeParse(answer).success).toBe(false);
    expect(
      AnswerQuestionInputSchema.safeParse({
        ...answer,
        related_run_id: 'run_1',
      }).success,
    ).toBe(true);
    expect(
      AnswerQuestionInputSchema.safeParse({
        ...answer,
        answer: 'Retest the changed pipeline first.',
        decision: 'revise',
      }).success,
    ).toBe(true);
  });

  it('rejects more than five test samples for one table', () => {
    expect(
      CompleteRunInputSchema.safeParse({
        run_id: 'run_1',
        outcome: 'completed',
        task_hash: hash,
        schema_hash: hash,
        pipeline_hash: hash,
        manifest: { command: 'test' },
        samples: { 'tesla-history': Array(6).fill(record) },
        table_counts: {},
        error: null,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate schema paths in one atomic set', () => {
    const schema = {
      path: 'schemas/tesla-history.yaml',
      schema: { version: 1 },
      schema_hash: hash,
    };

    expect(
      RegisterSchemaInputSchema.safeParse({
        task_id: 'task_1',
        schemas: [schema, { ...schema, schema_hash: 'b'.repeat(64) }],
        aggregate_schema_hash: hash,
      }).success,
    ).toBe(false);
  });

  it('rejects test samples for more than ten tables', () => {
    const samples = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`table-${index}`, []]),
    );

    expect(
      CompleteRunInputSchema.safeParse({
        run_id: 'run_1',
        outcome: 'completed',
        task_hash: hash,
        schema_hash: hash,
        pipeline_hash: hash,
        manifest: { command: 'test' },
        samples,
        table_counts: {},
        error: null,
      }).success,
    ).toBe(false);
  });
});
