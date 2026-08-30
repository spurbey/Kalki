import {
  type CreateTaskInput,
  type CreateWorkbookInput,
  TaskSchema,
  WorkbookSchema,
  WorkbookSnapshotSchema,
} from '@kalki/contracts';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';

export class WorkbookService {
  constructor(private readonly database: Database.Database) {}

  createWorkbook(input: CreateWorkbookInput) {
    const timestamp = new Date().toISOString();
    const workbook = WorkbookSchema.parse({
      id: `wb_${randomUUID()}`,
      title: input.title,
      trueforge_session_id: null,
      current_trueforge_turn_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workbooks(
             id, title, trueforge_session_id, current_trueforge_turn_id, created_at, updated_at
           ) VALUES (
             @id, @title, @trueforge_session_id, @current_trueforge_turn_id, @created_at, @updated_at
           )`,
        )
        .run(workbook);
      this.database
        .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(workbook.id, 'workbook.created', JSON.stringify({ workbook_id: workbook.id }), timestamp);
    })();

    return workbook;
  }

  createTask(workbookId: string, input: CreateTaskInput) {
    if (!this.database.prepare('SELECT 1 FROM workbooks WHERE id = ?').get(workbookId)) {
      throw new DomainError(`Workbook '${workbookId}' was not found`, 'not_found', 404);
    }

    const timestamp = new Date().toISOString();
    const task = TaskSchema.parse({
      id: `task_${randomUUID()}`,
      workbook_id: workbookId,
      slug: input.slug,
      title: input.title,
      objective: input.objective,
      state: 'aligning',
      task_path: null,
      task_markdown: null,
      task_hash: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO tasks(
               id, workbook_id, slug, title, objective, state, task_path, task_markdown, task_hash,
               created_at, updated_at
             ) VALUES (
               @id, @workbook_id, @slug, @title, @objective, @state, @task_path, @task_markdown, @task_hash,
               @created_at, @updated_at
             )`,
          )
          .run(task);
        this.database
          .prepare('INSERT INTO workbook_events(workbook_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
          .run(workbookId, 'task.created', JSON.stringify({ task_id: task.id }), timestamp);
      })();
    } catch (error) {
      if (
        error instanceof Database.SqliteError &&
        error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        error.message.includes('tasks.workbook_id, tasks.slug')
      ) {
        throw new DomainError(`Task slug '${input.slug}' already exists in this workbook`, 'task_slug_conflict', 409);
      }
      throw error;
    }

    return task;
  }

  getSnapshot(workbookId: string) {
    const workbookRow = this.database.prepare('SELECT * FROM workbooks WHERE id = ?').get(workbookId);
    if (!workbookRow) throw new DomainError(`Workbook '${workbookId}' was not found`, 'not_found', 404);

    const taskRows = this.database.prepare('SELECT * FROM tasks WHERE workbook_id = ? ORDER BY created_at').all(workbookId);

    return WorkbookSnapshotSchema.parse({
      workbook: WorkbookSchema.parse(workbookRow),
      tasks: taskRows.map(row => TaskSchema.parse(row)),
      tables: [],
      runs: [],
      pending_question: null,
      artifacts: [],
      generated_skills: [],
      table_counts: {},
    });
  }
}
