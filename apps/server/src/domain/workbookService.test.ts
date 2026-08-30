import { mkdtempSync, rmSync } from 'node:fs';
import { canonicalJson, TableSchemaDocumentSchema } from '@kalki/contracts';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { WorkbookService } from './workbookService.js';

const jsonHash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

describe('workbook persistence', () => {
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

  it('persists reviewed schemas and a test run', () => {
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

      const reopenedDatabase = openDatabase(path);
      const reopenedService = new WorkbookService(reopenedDatabase);
      const snapshot = reopenedService.getSnapshot(workbook.id);
      const context = reopenedService.getWorkbookContext({
        workbook_id: workbook.id,
        task_id: task.id,
      });
      reopenedDatabase.close();

      expect(snapshot.tasks[0]?.state).toBe('testing');
      expect(snapshot.tables).toHaveLength(4);
      expect(context.tables.map((table) => table.slug)).toEqual(['tesla-history', 'tesla-top-3']);
      expect(snapshot.runs).toHaveLength(2);
      expect(context.runs).toHaveLength(1);
      expect(context.runs[0]?.status).toBe('running');
      expect(context.aggregate_schema_hash).toBe(schemaHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
