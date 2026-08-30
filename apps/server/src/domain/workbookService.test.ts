import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { canonicalHashJson, canonicalJson, TableSchemaDocumentSchema } from '@kalki/contracts';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventStore } from '../events/eventStore.js';
import { WorkbookService } from './workbookService.js';

const jsonHash = (value: unknown) => createHash('sha256').update(canonicalHashJson(value)).digest('hex');

describe('workbook persistence', () => {
  it('uses the shared cross-language JSON hash representation', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../../../fixtures/hash-contract.json', import.meta.url), 'utf8'),
    ) as { value: unknown; sha256: string };

    expect(jsonHash(fixture.value)).toBe(fixture.sha256);
  });

  it('keeps a workbook and task after reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kalki-'));
    const path = join(directory, 'kalki.db');

    try {
      const firstDatabase = openDatabase(path);
      const firstService = new WorkbookService(firstDatabase);
      const workbook = firstService.createWorkbook({ title: 'Tesla research' });
      const task = firstService.createTask(workbook.id, {
        slug: 'tesla-top-prices',
        title: 'Tesla top prices',
        objective: 'Find the highest TSLA prices.',
      });
      const taskMarkdown = '# Task Contract\r\n\r\nFind the highest TSLA prices.\r\n';
      const taskHash = createHash('sha256').update(taskMarkdown.replace(/\r\n?/g, '\n')).digest('hex');
      expect(() =>
        firstService.registerTask({
          task_id: task.id,
          task_path: 'task.md',
          task_markdown: taskMarkdown,
          task_hash: '0'.repeat(64),
        }),
      ).toThrow();
      const registration = {
        task_id: task.id,
        task_path: 'task.md',
        task_markdown: taskMarkdown,
        task_hash: taskHash,
      };
      firstService.registerTask(registration);
      firstService.registerTask(registration);
      firstDatabase.close();

      const reopenedDatabase = openDatabase(path);
      const snapshot = new WorkbookService(reopenedDatabase).getSnapshot(workbook.id);
      reopenedDatabase.close();

      expect(snapshot.workbook.title).toBe('Tesla research');
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.tasks[0]?.state).toBe('awaiting_task_confirmation');
      expect(snapshot.tasks[0]?.task_path).toBe('task.md');
      expect(snapshot.tasks[0]?.task_hash).toBe(taskHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers the current TrueForge turn after reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kalki-'));
    const path = join(directory, 'kalki.db');

    try {
      const firstDatabase = openDatabase(path);
      const firstService = new WorkbookService(firstDatabase);
      const workbook = firstService.createWorkbook({ title: 'Tesla research' });
      expect(() => firstService.connectTrueForgeSession(workbook.id, 'x'.repeat(129))).toThrow();
      expect(firstService.getWorkbook(workbook.id).trueforge_session_id).toBeNull();
      firstService.connectTrueForgeSession(workbook.id, 'session-1');
      expect(() =>
        firstService.saveTrueForgeTurn(workbook.id, {
          id: 'invalid-turn',
          sessionId: 'session-1',
          previousTurnId: null,
          status: 'running',
          requiredActions: [],
          createdAt: 'not-a-timestamp',
          finishedAt: null,
        }),
      ).toThrow();
      expect(firstService.getWorkbook(workbook.id).current_trueforge_turn_id).toBeNull();
      firstService.saveTrueForgeTurn(workbook.id, {
        id: 'turn-1',
        sessionId: 'session-1',
        previousTurnId: null,
        status: 'running',
        requiredActions: [],
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      firstService.saveTrueForgeTurn(workbook.id, {
        id: 'turn-1',
        sessionId: 'session-1',
        previousTurnId: null,
        status: 'done',
        requiredActions: [],
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      firstDatabase.close();

      const reopenedDatabase = openDatabase(path);
      const reopenedService = new WorkbookService(reopenedDatabase);
      const recoveredWorkbook = reopenedService.getWorkbook(workbook.id);
      const recoveredTurn = reopenedService.getCurrentTrueForgeTurn(workbook.id);
      reopenedDatabase.close();

      expect(recoveredWorkbook.trueforge_session_id).toBe('session-1');
      expect(recoveredWorkbook.current_trueforge_turn_id).toBe('turn-1');
      expect(recoveredTurn?.status).toBe('done');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stores each streamed TrueForge event sequence once', () => {
    const database = openDatabase(':memory:');
    const service = new WorkbookService(database);
    const eventStore = new EventStore(database);

    try {
      const workbook = service.createWorkbook({ title: 'Tesla research' });
      service.connectTrueForgeSession(workbook.id, 'session-1');
      service.saveTrueForgeTurn(workbook.id, {
        id: 'turn-1',
        sessionId: 'session-1',
        previousTurnId: null,
        status: 'running',
        requiredActions: [],
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      const after = eventStore.listAfter(workbook.id, 0).at(-1)?.seq ?? 0;

      expect(
        eventStore.appendTurnEvent(workbook.id, 'turn-1', 1, 'agent.turn.created', {}),
      ).not.toBeNull();
      expect(eventStore.appendTurnEvent(workbook.id, 'turn-1', 1, 'agent.turn.created', {})).toBeNull();
      expect(
        eventStore.appendTurnEvent(workbook.id, 'turn-1', 2, 'agent.model.message.delta', {}),
      ).not.toBeNull();
      expect(eventStore.listAfter(workbook.id, after)).toHaveLength(2);
      expect(service.getCurrentTrueForgeTurn(workbook.id)?.last_sequence_number).toBe(2);
    } finally {
      database.close();
    }
  });

  it('validates review decisions and completes clarifications', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kalki-'));
    const path = join(directory, 'kalki.db');
    const database = openDatabase(path);

    try {
      const service = new WorkbookService(database);
      const workbook = service.createWorkbook({ title: 'Tesla research' });
      const task = service.createTask(workbook.id, {
        slug: 'tesla-top-prices',
        title: 'Tesla top prices',
        objective: 'Find the highest TSLA prices.',
      });
      database.prepare("UPDATE tasks SET state = 'awaiting_task_confirmation' WHERE id = ?").run(task.id);
      service.connectTrueForgeSession(workbook.id, 'session-1');
      const timestamp = new Date().toISOString();
      service.saveTrueForgeTurn(workbook.id, {
        id: 'turn-question',
        sessionId: 'session-1',
        previousTurnId: null,
        status: 'done',
        requiredActions: [],
        createdAt: timestamp,
        finishedAt: timestamp,
      });

      const question = {
        taskId: task.id,
        runId: null,
        questionTurnId: 'turn-question',
        threadId: 'main',
        options: ['Continue'],
      };
      const answer = {
        question_turn_id: 'turn-question',
        thread_id: 'main',
      };
      service.savePendingQuestion(workbook.id, {
        ...question,
        gateKind: 'task_review',
        questionEventId: 'event-task-review',
        toolCallId: 'tool-task-review',
        questionText: 'Approve this task?',
      });
      expect(() =>
        service.markQuestionSubmitting(workbook.id, 'tool-task-review', {
          ...answer,
          question_event_id: 'event-task-review',
          answer: 'Something else',
          decision: 'free_text',
          gate_kind: 'task_review',
        }),
      ).toThrow();
      expect(service.getPendingQuestion(workbook.id)?.status).toBe('pending');

      service.savePendingQuestion(workbook.id, {
        ...question,
        gateKind: 'clarification',
        questionEventId: 'event-clarification',
        toolCallId: 'tool-clarification',
        questionText: 'Which date range?',
      });
      const clarification = {
        ...answer,
        question_event_id: 'event-clarification',
        answer: 'Five years',
        decision: 'free_text' as const,
        gate_kind: 'clarification' as const,
      };
      service.markQuestionSubmitting(workbook.id, 'tool-clarification', clarification);
      service.completeQuestion(workbook.id, 'tool-clarification', clarification, 'turn-question');

      const saved = database
        .prepare('SELECT status FROM agent_questions WHERE tool_call_id = ?')
        .get('tool-clarification') as { status: string };
      expect(saved.status).toBe('answered');
      expect(service.getSnapshot(workbook.id).tasks[0]?.state).toBe('awaiting_task_confirmation');
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists reviewed schemas and a test run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kalki-'));
    const path = join(directory, 'kalki.db');
    let firstDatabase: ReturnType<typeof openDatabase> | null = null;
    let reopenedDatabase: ReturnType<typeof openDatabase> | null = null;

    try {
      firstDatabase = openDatabase(path);
      const firstService = new WorkbookService(firstDatabase);
      const workbook = firstService.createWorkbook({ title: 'Tesla research' });
      const task = firstService.createTask(workbook.id, {
        slug: 'tesla-top-prices',
        title: 'Tesla top prices',
        objective: 'Find the highest TSLA prices.',
      });
      const taskMarkdown = '# Task Contract\n\nFind the highest TSLA prices.\n';
      const taskHash = createHash('sha256').update(taskMarkdown).digest('hex');
      firstService.registerTask({
        task_id: task.id,
        task_path: 'task.md',
        task_markdown: taskMarkdown,
        task_hash: taskHash,
      });
      firstDatabase.prepare("UPDATE tasks SET state = 'exploring' WHERE id = ?").run(task.id);

      const historySchema = TableSchemaDocumentSchema.parse({
        columns: [
          {
            description: 'Trading date.',
            name: 'date',
            nullable: false,
            type: 'date',
          },
        ],
        table: {
          description: 'Daily TSLA prices.',
          kind: 'source',
          name: 'Tesla Daily History',
          primary_key: ['date'],
          slug: 'tesla-history',
        },
        version: 1,
      });
      const topSchema = TableSchemaDocumentSchema.parse({
        columns: [
          {
            description: 'Result rank.',
            name: 'rank',
            nullable: false,
            type: 'integer',
          },
        ],
        table: {
          description: 'Highest TSLA prices.',
          kind: 'derived',
          name: 'Tesla Highest Daily Prices',
          primary_key: ['rank'],
          slug: 'tesla-top-3',
        },
        version: 1,
      });
      const schemas = [
        {
          path: 'schemas/tesla-history.yaml',
          schema: historySchema,
          schema_hash: jsonHash(historySchema),
        },
        {
          path: 'schemas/tesla-top-3.yaml',
          schema: topSchema,
          schema_hash: jsonHash(topSchema),
        },
      ];
      const schemaHash = jsonHash(
        schemas.map((schema) => ({
          path: schema.path,
          sha256: schema.schema_hash,
        })),
      );
      const registration = {
        task_id: task.id,
        schemas,
        aggregate_schema_hash: schemaHash,
      };
      firstService.registerSchema(registration);
      firstService.registerSchema(registration);

      firstDatabase.prepare("UPDATE tasks SET state = 'building' WHERE id = ?").run(task.id);
      const run = {
        run_id: 'run_tesla_test',
        task_id: task.id,
        mode: 'test' as const,
        task_hash: taskHash,
        schema_hash: schemaHash,
        pipeline_hash: 'b'.repeat(64),
      };
      firstService.startRun(run);
      firstService.startRun(run);

      const directProvenance = {
        kind: 'direct' as const,
        source_url: 'https://query2.finance.yahoo.com/v8/finance/chart/TSLA',
        retrieved_at: new Date().toISOString(),
        parents: [],
      };
      const sourceSamples = Array.from({ length: 5 }, (_, index) => ({
        data: { date: `2025-01-0${index + 2}` },
        dedupe_key: `2025-01-0${index + 2}`,
        provenance: directProvenance,
      }));
      const derivedSamples = Array.from({ length: 5 }, (_, index) => ({
        data: { rank: index + 1 },
        dedupe_key: String(index + 1),
        provenance: {
          kind: 'derived' as const,
          source_url: 'https://query2.finance.yahoo.com/v8/finance/chart/TSLA',
          retrieved_at: directProvenance.retrieved_at,
          parents: [{ table_slug: 'tesla-history', dedupe_key: sourceSamples[index]!.dedupe_key }],
        },
      }));
      const completion = {
        run_id: run.run_id,
        outcome: 'completed' as const,
        task_hash: run.task_hash,
        schema_hash: run.schema_hash,
        pipeline_hash: run.pipeline_hash,
        manifest: {
          ok: true,
          command: 'test',
          run_id: run.run_id,
          mode: 'test',
          state: 'ready_to_finalize',
          task_hash: run.task_hash,
          schema_hash: run.schema_hash,
          pipeline_hash: run.pipeline_hash,
          counts: { source_records: 5, derived_records: 7 },
          tables: {
            'tesla-history': { count: 5 },
            'tesla-top-3': { count: 7 },
          },
          done: true,
          error: null,
        },
        samples: {
          'tesla-history': sourceSamples,
          'tesla-top-3': derivedSamples,
        },
        table_counts: {},
        error: null,
      };
      firstService.completeRun(completion);
      firstService.completeRun(completion);

      const productionRun = {
        ...run,
        run_id: 'run_tesla_production',
        mode: 'production' as const,
      };
      firstService.startRun(productionRun);
      firstService.connectTrueForgeSession(workbook.id, 'session-production');
      const questionTime = new Date().toISOString();
      firstService.saveTrueForgeTurn(workbook.id, {
        id: 'turn-production-question',
        sessionId: 'session-production',
        previousTurnId: null,
        status: 'done',
        requiredActions: [],
        createdAt: questionTime,
        finishedAt: questionTime,
      });
      firstService.savePendingQuestion(workbook.id, {
        taskId: task.id,
        runId: productionRun.run_id,
        gateKind: 'production_review',
        questionTurnId: 'turn-production-question',
        questionEventId: 'event-production-review',
        toolCallId: 'tool-production-review',
        threadId: 'main',
        questionText: 'Publish the complete Tesla dataset?',
        options: ['Approve', 'Revise', 'Cancel'],
      });
      const productionAnswer = {
        question_event_id: 'event-production-review',
        question_turn_id: 'turn-production-question',
        thread_id: 'main',
        answer: 'Approve production',
        decision: 'approve' as const,
        gate_kind: 'production_review' as const,
        related_run_id: productionRun.run_id,
      };
      firstService.markQuestionSubmitting(workbook.id, 'tool-production-review', productionAnswer);
      firstService.saveTrueForgeTurn(workbook.id, {
        id: 'turn-production-answer',
        sessionId: 'session-production',
        previousTurnId: 'turn-production-question',
        status: 'done',
        requiredActions: [],
        createdAt: questionTime,
        finishedAt: questionTime,
      });
      firstService.completeQuestion(
        workbook.id,
        'tool-production-review',
        productionAnswer,
        'turn-production-answer',
      );
      const productionHashes = {
        task_hash: productionRun.task_hash,
        schema_hash: productionRun.schema_hash,
        pipeline_hash: productionRun.pipeline_hash,
      };
      expect(
        firstService.getProductionAuthorization({ run_id: productionRun.run_id, ...productionHashes }).authorized,
      ).toBe(true);

      const testBatchRecords = sourceSamples.slice(0, 1);
      expect(() =>
        firstService.publishBatch({
          run_id: run.run_id,
          task_hash: run.task_hash,
          schema_hash: run.schema_hash,
          pipeline_hash: run.pipeline_hash,
          table_slug: 'tesla-history',
          batch_key: 'tesla-history:00000000',
          payload_hash: jsonHash({
            run_id: run.run_id,
            table_slug: 'tesla-history',
            batch_key: 'tesla-history:00000000',
            records: testBatchRecords,
          }),
          records: testBatchRecords,
        }),
      ).toThrow();

      const sourceBatch = {
        run_id: productionRun.run_id,
        ...productionHashes,
        table_slug: 'tesla-history',
        batch_key: 'tesla-history:00000000',
        payload_hash: jsonHash({
          run_id: productionRun.run_id,
          table_slug: 'tesla-history',
          batch_key: 'tesla-history:00000000',
          records: sourceSamples,
        }),
        records: sourceSamples,
      };
      expect(firstService.publishBatch(sourceBatch)).toMatchObject({ inserted: 5, replayed: false });
      expect(firstService.publishBatch(sourceBatch)).toMatchObject({ inserted: 5, replayed: true });
      expect(() =>
        firstService.publishBatch({
          ...sourceBatch,
          pipeline_hash: 'c'.repeat(64),
        }),
      ).toThrow();
      const changedSourceRecords = sourceSamples.slice(0, 4);
      expect(() =>
        firstService.publishBatch({
          ...sourceBatch,
          payload_hash: jsonHash({
            run_id: productionRun.run_id,
            table_slug: sourceBatch.table_slug,
            batch_key: sourceBatch.batch_key,
            records: changedSourceRecords,
          }),
          records: changedSourceRecords,
        }),
      ).toThrow();

      const productionDerivedRecords = derivedSamples.slice(0, 3);
      const derivedBatch = {
        run_id: productionRun.run_id,
        ...productionHashes,
        table_slug: 'tesla-top-3',
        batch_key: 'tesla-top-3:00000000',
        payload_hash: jsonHash({
          run_id: productionRun.run_id,
          table_slug: 'tesla-top-3',
          batch_key: 'tesla-top-3:00000000',
          records: productionDerivedRecords,
        }),
        records: productionDerivedRecords,
      };
      expect(firstService.publishBatch(derivedBatch)).toMatchObject({ inserted: 3, published_row_count: 8 });
      firstService.recordArtifact({
        run_id: productionRun.run_id,
        trueforge_turn_id: 'turn-production-answer',
        kind: 'report',
        path: 'artifacts/run-report.md',
        sha256: 'c'.repeat(64),
        size_bytes: 128,
        mime_type: 'text/markdown',
        metadata: { scan: { status: 'passed', scanner_version: 1 } },
        task_hash: productionRun.task_hash,
        schema_hash: productionRun.schema_hash,
        pipeline_hash: productionRun.pipeline_hash,
      });
      const productionCompletion = {
        run_id: productionRun.run_id,
        outcome: 'completed' as const,
        task_hash: productionRun.task_hash,
        schema_hash: productionRun.schema_hash,
        pipeline_hash: productionRun.pipeline_hash,
        manifest: {
          ok: true,
          command: 'finalize',
          run_id: productionRun.run_id,
          mode: 'production',
          state: 'ready_to_finalize',
          task_hash: productionRun.task_hash,
          schema_hash: productionRun.schema_hash,
          pipeline_hash: productionRun.pipeline_hash,
          counts: { source_records: 5, derived_records: 3 },
          tables: {
            'tesla-history': { count: 5 },
            'tesla-top-3': { count: 3 },
          },
          done: true,
          error: null,
        },
        samples: {},
        table_counts: { 'tesla-history': 5, 'tesla-top-3': 3 },
        error: null,
      };
      firstService.completeRun(productionCompletion);
      firstService.completeRun(productionCompletion);

      const otherTask = firstService.createTask(workbook.id, {
        slug: 'other-task',
        title: 'Other task',
        objective: 'Keep compact context task-scoped.',
      });
      const otherTaskMarkdown = '# Other Task\n';
      const otherTaskHash = createHash('sha256').update(otherTaskMarkdown).digest('hex');
      firstService.registerTask({
        task_id: otherTask.id,
        task_path: 'other-task.md',
        task_markdown: otherTaskMarkdown,
        task_hash: otherTaskHash,
      });
      firstDatabase.prepare("UPDATE tasks SET state = 'exploring' WHERE id = ?").run(otherTask.id);
      firstService.registerSchema({ ...registration, task_id: otherTask.id });
      firstDatabase.prepare("UPDATE tasks SET state = 'building' WHERE id = ?").run(otherTask.id);
      firstService.startRun({ ...run, run_id: 'run_other_test', task_id: otherTask.id, task_hash: otherTaskHash });
      firstDatabase.close();
      firstDatabase = null;

      reopenedDatabase = openDatabase(path);
      const reopenedService = new WorkbookService(reopenedDatabase);
      const snapshot = reopenedService.getSnapshot(workbook.id);
      const context = reopenedService.getWorkbookContext({
        workbook_id: workbook.id,
        task_id: task.id,
      });

      expect(snapshot.tasks[0]?.state).toBe('completed');
      expect(snapshot.tables).toHaveLength(4);
      expect(context.tables.map((table) => table.slug)).toEqual(['tesla-history', 'tesla-top-3']);
      expect(snapshot.runs).toHaveLength(3);
      expect(context.runs).toHaveLength(2);
      expect(context.runs.find((candidate) => candidate.mode === 'test')?.status).toBe('completed');
      expect(context.runs.find((candidate) => candidate.mode === 'production')?.status).toBe('completed');
      expect(snapshot.runs[0]?.test_samples?.['tesla-history']).toHaveLength(5);
      expect(context.runs.find((candidate) => candidate.mode === 'test')?.counts.formal_rows).toBe(0);
      expect(context.runs.find((candidate) => candidate.mode === 'production')?.counts.formal_rows).toBe(8);
      expect(context.aggregate_schema_hash).toBe(schemaHash);
      expect(snapshot.artifacts).toHaveLength(1);
      expect(Object.values(snapshot.table_counts).reduce((sum, count) => sum + count, 0)).toBe(8);
      expect(
        reopenedDatabase.prepare('SELECT count(*) AS count FROM approval_events').get(),
      ).toEqual({ count: 1 });
      reopenedDatabase.close();
      reopenedDatabase = null;
    } finally {
      firstDatabase?.close();
      reopenedDatabase?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
