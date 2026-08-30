import { describe, expect, it } from 'vitest';
import {
  BoundedSamplesSchema,
  JsonObjectSchema,
  ProvenanceSchema,
  RecordEnvelopeSchema,
  RunSchema,
  TrueForgeStreamEventSchema,
  WorkbookSnapshotSchema,
  WorkspaceRelativePathSchema,
} from './domain.js';

const hash = 'a'.repeat(64);

const directProvenance = {
  kind: 'direct',
  source_url: 'https://query1.finance.yahoo.com/v8/finance/chart/TSLA',
  retrieved_at: '2026-08-29T12:00:00Z',
  source_record_id: 'TSLA:2025-01-02',
  parents: [],
} as const;

describe('workspace paths', () => {
  it('accepts normalized relative paths', () => {
    expect(WorkspaceRelativePathSchema.safeParse('research/yahoo-network-evidence.json').success).toBe(true);
  });

  it.each(['/workspace/task.md', 'C:\\task.md', '../task.md', 'runs//source.jsonl'])(
    'rejects non-portable path %s',
    path => {
      expect(WorkspaceRelativePathSchema.safeParse(path).success).toBe(false);
    },
  );
});

describe('provenance', () => {
  it('requires direct records to have no parents', () => {
    expect(ProvenanceSchema.safeParse(directProvenance).success).toBe(true);
    expect(
      ProvenanceSchema.safeParse({
        ...directProvenance,
        parents: [{ table_slug: 'tesla-history', dedupe_key: '2025-01-02' }],
      }).success,
    ).toBe(false);
  });

  it('requires derived records to identify a parent', () => {
    expect(ProvenanceSchema.safeParse({ ...directProvenance, kind: 'derived' }).success).toBe(false);
    expect(
      ProvenanceSchema.safeParse({
        ...directProvenance,
        kind: 'derived',
        parents: [{ table_slug: 'tesla-history', dedupe_key: '2025-01-02' }],
      }).success,
    ).toBe(true);
  });

  it('rejects non-HTTPS source URLs', () => {
    expect(ProvenanceSchema.safeParse({ ...directProvenance, source_url: 'http://example.com' }).success).toBe(false);
  });

  it('uses the canonical UTF-8 dedupe-key limit for parent references', () => {
    expect(
      ProvenanceSchema.safeParse({
        ...directProvenance,
        kind: 'derived',
        parents: [{ table_slug: 'tesla-history', dedupe_key: 'e'.repeat(512) }],
      }).success,
    ).toBe(true);
    expect(
      ProvenanceSchema.safeParse({
        ...directProvenance,
        kind: 'derived',
        parents: [{ table_slug: 'tesla-history', dedupe_key: '\u00e9'.repeat(257) }],
      }).success,
    ).toBe(false);
  });
});

describe('JSON values', () => {
  it('accepts nested JSON data', () => {
    expect(
      JsonObjectSchema.safeParse({
        symbol: 'TSLA',
        prices: [379.28, null],
        metadata: { adjusted: true },
      }).success,
    ).toBe(true);
  });

  it.each([1n, undefined, () => undefined, new Date(), new Map()])('rejects non-JSON value %#', value => {
    expect(JsonObjectSchema.safeParse({ value }).success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    expect(JsonObjectSchema.safeParse({ value: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});

describe('TrueForge stream events', () => {
  it('keeps event names within the workbook event boundary', () => {
    expect(TrueForgeStreamEventSchema.safeParse({ type: 'x'.repeat(94) }).success).toBe(true);
    expect(TrueForgeStreamEventSchema.safeParse({ type: 'x'.repeat(95) }).success).toBe(false);
    expect(TrueForgeStreamEventSchema.safeParse({ type: 'turn\ncreated' }).success).toBe(false);
  });
});

describe('record envelopes', () => {
  it('rejects unknown envelope keys', () => {
    expect(
      RecordEnvelopeSchema.safeParse({
        data: { date: '2025-01-02' },
        dedupe_key: '2025-01-02',
        provenance: directProvenance,
        formal_row_id: 'row_123',
      }).success,
    ).toBe(false);
  });

  it('enforces the UTF-8 byte limit for dedupe keys', () => {
    expect(
      RecordEnvelopeSchema.safeParse({
        data: {},
        dedupe_key: 'x'.repeat(513),
        provenance: directProvenance,
      }).success,
    ).toBe(false);
  });
});

describe('test samples', () => {
  it('caps the number of sampled tables', () => {
    const tenTables = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`table-${index}`, []]));
    const elevenTables = { ...tenTables, 'table-10': [] };

    expect(BoundedSamplesSchema.safeParse(tenTables).success).toBe(true);
    expect(BoundedSamplesSchema.safeParse(elevenTables).success).toBe(false);
  });
});

describe('run approval evidence', () => {
  const awaitingProductionRun = {
    id: 'run_1',
    task_id: 'task_1',
    mode: 'production',
    status: 'awaiting_confirmation',
    task_hash: hash,
    schema_hash: hash,
    pipeline_hash: hash,
    approved_at: null,
    approval_event_id: null,
    approved_task_hash: null,
    approved_schema_hash: null,
    approved_pipeline_hash: null,
    test_manifest: null,
    test_samples: null,
    published_row_count: 0,
    total_record_count: null,
    error: null,
    created_at: '2026-08-29T12:00:00Z',
    started_at: null,
    finished_at: null,
    updated_at: '2026-08-29T12:00:00Z',
  } as const;

  const approval = {
    approved_at: '2026-08-29T12:05:00Z',
    approval_event_id: 'approval_1',
    approved_task_hash: hash,
    approved_schema_hash: hash,
    approved_pipeline_hash: hash,
  } as const;

  it('accepts an awaiting-confirmation production run without approval', () => {
    expect(RunSchema.safeParse(awaitingProductionRun).success).toBe(true);
  });

  it('requires complete approval evidence for authorized production', () => {
    expect(RunSchema.safeParse({ ...awaitingProductionRun, status: 'authorized' }).success).toBe(false);
    expect(
      RunSchema.safeParse({
        ...awaitingProductionRun,
        status: 'authorized',
        ...approval,
      }).success,
    ).toBe(true);
  });

  it('rejects partial or hash-mismatched approval evidence', () => {
    expect(
      RunSchema.safeParse({
        ...awaitingProductionRun,
        status: 'authorized',
        approved_at: approval.approved_at,
      }).success,
    ).toBe(false);
    expect(
      RunSchema.safeParse({
        ...awaitingProductionRun,
        status: 'running',
        ...approval,
        approved_pipeline_hash: 'b'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('rejects production approval evidence on test runs', () => {
    expect(
      RunSchema.safeParse({
        ...awaitingProductionRun,
        mode: 'test',
        status: 'running',
        ...approval,
      }).success,
    ).toBe(false);
  });

  it('allows production failure before or after valid approval', () => {
    expect(RunSchema.safeParse({ ...awaitingProductionRun, status: 'failed' }).success).toBe(true);
    expect(
      RunSchema.safeParse({
        ...awaitingProductionRun,
        status: 'failed',
        ...approval,
      }).success,
    ).toBe(true);
  });
});

describe('workbook snapshots', () => {
  it('do not accept formal row payloads', () => {
    const snapshot = {
      workbook: {
        id: 'workbook_1',
        title: 'Tesla research',
        trueforge_session_id: null,
        current_trueforge_turn_id: null,
        created_at: '2026-08-29T12:00:00Z',
        updated_at: '2026-08-29T12:00:00Z',
      },
      tasks: [],
      tables: [],
      runs: [],
      pending_question: null,
      artifacts: [],
      generated_skills: [],
      table_counts: {},
    };

    expect(WorkbookSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      WorkbookSnapshotSchema.safeParse({
        ...snapshot,
        rows: {},
      }).success,
    ).toBe(false);
  });
});
