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
});
