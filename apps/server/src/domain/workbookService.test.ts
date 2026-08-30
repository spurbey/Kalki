import { mkdtempSync, rmSync } from 'node:fs';
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
      firstService.createTask(workbook.id, {
        slug: 'tesla-top-prices',
        title: 'Tesla top prices',
        objective: 'Find the highest TSLA prices.',
      });
      firstDatabase.close();

      const reopenedDatabase = openDatabase(path);
      const snapshot = new WorkbookService(reopenedDatabase).getSnapshot(workbook.id);
      reopenedDatabase.close();

      expect(snapshot.workbook.title).toBe('Tesla research');
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.tasks[0]?.state).toBe('aligning');
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
      firstService.connectTrueForgeSession(workbook.id, 'session-1');
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
