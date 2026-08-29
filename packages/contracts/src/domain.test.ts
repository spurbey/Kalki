import { describe, expect, it } from 'vitest';
import {
  ProvenanceSchema,
  RecordEnvelopeSchema,
  WorkbookSnapshotSchema,
  WorkspaceRelativePathSchema,
} from './domain.js';

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
