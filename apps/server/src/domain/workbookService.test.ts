import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { WorkbookService } from './workbookService.js';

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
});
